import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CapabilityArtifact,
  DeclaredOutcome,
  Health,
  InputParam,
  OutputField,
  PolicyBinding,
  Provenance,
  Recovery,
  Step,
  TargetBinding,
  TargetDescriptor,
  type Condition,
} from "@workspace/contracts"
import { coreBankReadonly, makeRedactor } from "@workspace/policy"
import { ControlLease, makeWebSurface, type Surface } from "@workspace/surface"
import { Effect } from "effect"
import { chromium, type Browser, type Page } from "playwright"
import { startCoreBank, type CoreBankTestServer } from "target-corebank/testing"
import { armFault } from "target-corebank/faults"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { makeEvidenceWriter, type EvidenceWriter } from "../src/evidence.js"
import {
  buildTestCapability,
  button,
  testVault,
  textPresent,
} from "./fixtures/capability.js"
import type { Vault } from "../src/replay/bindings.js"
import { runReplay } from "../src/replay/executor.js"

/**
 * Replay against the real application, with every runtime condition the stand-in
 * can produce.
 *
 * This is the Phase 4 gate and the heart of §3.3: each fault has to land on the
 * *correct branch* of the result union, not merely fail differently. The
 * distinction the brief calls the most common design mistake — a business
 * outcome reported as a crash — is the thing these tests exist to prevent
 * regressing.
 */

let corebank: CoreBankTestServer
let browser: Browser
let page: Page
let surface: Surface
let lease: ControlLease
let evidence: EvidenceWriter
let evidenceRoot: string

const vault = testVault

const lookupCapability = () => buildTestCapability()

const allowlistFor = (baseUrl: string) =>
  ({
    ...coreBankReadonly,
    allowedOrigins: [new URL(baseUrl).origin],
  }) as typeof coreBankReadonly

const replay = (
  inputs: Record<string, string>,
  artifact = lookupCapability()
) =>
  Effect.runPromise(
    runReplay(
      {
        surface,
        evidence,
        allowlist: allowlistFor(corebank.baseUrl),
        lease,
        vault,
      },
      { artifact, inputs, baseUrl: corebank.baseUrl }
    )
  )

beforeAll(async () => {
  corebank = await startCoreBank()
  browser = await chromium.launch()
  evidenceRoot = await mkdtemp(join(tmpdir(), "cua-replay-"))
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await corebank.stop()
})

beforeEach(async () => {
  corebank.reset()
  page = await browser.newPage()
  lease = new ControlLease()
  surface = await Effect.runPromise(makeWebSurface({ page, lease }))

  evidence = await makeEvidenceWriter({
    root: evidenceRoot,
    runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    redactor: makeRedactor({ values: ["demo-pass", "teller01"] }),
  })
})

describe("the happy path", () => {
  it("replays without a model and returns the declared output", async () => {
    const result = await replay({ memberId: "12345" })

    expect(result._tag).toBe("Succeeded")
    if (result._tag !== "Succeeded") return

    expect(result.outputs["savingsBalance"]).toContain("4,812.65")
    expect(result.summary.stepsAttempted).toBe(7)
  })

  it("is deterministic — the same inputs give the same answer", async () => {
    const first = await replay({ memberId: "12345" })

    corebank.reset()
    await page.close()
    page = await browser.newPage()
    lease = new ControlLease()
    surface = await Effect.runPromise(makeWebSurface({ page, lease }))

    const second = await replay({ memberId: "12345" })

    expect(first._tag).toBe("Succeeded")
    expect(second._tag).toBe("Succeeded")
    if (first._tag !== "Succeeded" || second._tag !== "Succeeded") return
    expect(second.outputs).toEqual(first.outputs)
  })

  it("works for a different member, because nothing was hard-coded", async () => {
    const result = await replay({ memberId: "23456" })

    expect(result._tag).toBe("Succeeded")
    if (result._tag !== "Succeeded") return
    expect(result.outputs["savingsBalance"]).toContain("250.00")
  })
})

describe("expected business outcomes", () => {
  /** The distinction the whole result contract exists for. */
  it("reports a missing member as an outcome, not a failure", async () => {
    const result = await replay({ memberId: "99999" })

    expect(result._tag).toBe("BusinessOutcome")
    if (result._tag !== "BusinessOutcome") return

    expect(result.outcome).toBe("MemberNotFound")
    expect(result.atStepId).toBe("s6")
  })

  it("reports a permission denial as an outcome", async () => {
    const result = await replay({ memberId: "55555" })

    expect(result._tag).toBe("BusinessOutcome")
    if (result._tag !== "BusinessOutcome") return
    expect(result.outcome).toBe("AccountRestricted")
  })

  it("never reports an outcome as an error, whatever the http status", async () => {
    // The stand-in answers 404 for not-found and 403 for restricted. Neither is
    // a malfunction, and a caller that retried them would wait forever.
    for (const memberId of ["99999", "55555"]) {
      corebank.reset()
      const result = await replay({ memberId })
      expect(result._tag).not.toBe("Failed")
    }
  })
})

describe("recoverable conditions", () => {
  it("dismisses an unexpected interstitial and carries on", async () => {
    armFault("interstitial", 1)

    const result = await replay({ memberId: "12345" })

    expect(result._tag).toBe("Succeeded")
    if (result._tag !== "Succeeded") return

    // The caller is never told about it; the trace is where it shows up.
    const recovered = result.trace.filter(
      (event) => event._tag === "RecoveryApplied"
    )
    expect(recovered.length).toBeGreaterThan(0)
  })

  it("re-authenticates when the session expires mid-flow", async () => {
    armFault("session-expired", 1)

    const result = await replay({ memberId: "12345" })

    expect(result._tag).toBe("Succeeded")
    if (result._tag !== "Succeeded") return
    expect(
      result.trace.some(
        (event) =>
          event._tag === "RecoveryApplied" && event.recovery === "__session"
      )
    ).toBe(true)
  })

  it("survives a slow response rather than treating it as a failure", async () => {
    armFault("slow", 1)

    const result = await replay({ memberId: "12345" })

    expect(result._tag).toBe("Succeeded")
  })
})

describe("hard failures", () => {
  it("stops on an application error and says so", async () => {
    armFault("server-error", 4)

    const result = await replay({ memberId: "12345" })

    expect(result._tag).toBe("Failed")
    if (result._tag !== "Failed") return
    expect(result.error._tag).toBe("ApplicationError")
  })

  it("reports which step failed, what was expected and what was seen", async () => {
    const artifact = lookupCapability()
    const broken = new CapabilityArtifact({
      ...artifact,
      steps: artifact.steps.map((step) =>
        step.id === "s6"
          ? new Step({
              ...step,
              checkpoint: textPresent("A Heading That Does Not Exist"),
            })
          : step
      ),
    })

    const result = await replay({ memberId: "12345" }, broken)

    expect(result._tag).toBe("Failed")
    if (result._tag !== "Failed" || result.error._tag !== "CheckpointFailed") {
      throw new Error(
        `expected CheckpointFailed, got ${JSON.stringify(result)}`
      )
    }

    expect(result.error.stepId).toBe("s6")
    expect(result.error.expected).toContain("A Heading That Does Not Exist")
    // The observed side has to carry what was actually on screen, or the error
    // is not debuggable without re-running it.
    expect(result.error.observed.length).toBeGreaterThan(0)
  })

  it("reports a target that no longer resolves", async () => {
    const artifact = lookupCapability()
    const broken = new CapabilityArtifact({
      ...artifact,
      steps: artifact.steps.map((step) =>
        step.id === "s6"
          ? new Step({
              ...step,
              action: { _tag: "click", target: button("No Such Button") },
              checkpoint: undefined,
            })
          : step
      ),
    })

    const result = await replay({ memberId: "12345" }, broken)

    expect(result._tag).toBe("Failed")
    if (result._tag !== "Failed") return
    expect(result.error._tag).toBe("TargetNotFound")
  })
})

describe("the calling contract", () => {
  it("rejects a bad input before opening anything", async () => {
    const result = await replay({ memberId: "not-a-number" })

    expect(result._tag).toBe("Failed")
    if (
      result._tag !== "Failed" ||
      result.error._tag !== "InputValidationFailed"
    ) {
      throw new Error(
        `expected InputValidationFailed, got ${JSON.stringify(result)}`
      )
    }

    expect(result.error.issues[0]).toContain("memberId")
    // Nothing was attempted, so nothing could have changed.
    expect(result.summary.stepsAttempted).toBe(0)
  })

  it("rejects a missing required input", async () => {
    const result = await replay({})

    expect(result._tag).toBe("Failed")
    if (result._tag !== "Failed") return
    expect(result.error._tag).toBe("InputValidationFailed")
  })

  it("does not quote a sensitive input back in the error", async () => {
    const result = await replay({ memberId: "not-a-number" })

    if (
      result._tag !== "Failed" ||
      result.error._tag !== "InputValidationFailed"
    )
      return
    expect(result.error.issues.join(" ")).not.toContain("not-a-number")
  })
})

describe("the guardrail during replay", () => {
  it("escalates rather than performing an irreversible step", async () => {
    const artifact = lookupCapability()
    const risky = new CapabilityArtifact({
      ...artifact,
      // A capability that was recorded as read-only but now contains a step
      // policy classes as irreversible: the guardrail, not the artifact, decides.
      steps: [
        ...artifact.steps,
        new Step({
          id: "s8",
          intent: "Close the member's account.",
          action: { _tag: "click", target: button("Close Account") },
          riskClass: "safe",
          timeoutMs: 10_000,
        }),
      ],
    })

    const result = await replay({ memberId: "12345" }, risky)

    expect(result._tag).toBe("Escalated")
    if (result._tag !== "Escalated") return

    expect(result.atStepId).toBe("s8")
    expect(result.interventionId).toMatch(/^int-/)
    expect(result.reason).toContain("irreversible")
  })
})

describe("evidence", () => {
  it("records why each step ran and which strategy resolved it", async () => {
    const result = await replay({ memberId: "12345" })
    if (result._tag !== "Succeeded") throw new Error("expected success")

    const started = result.trace.filter((event) => event._tag === "StepStarted")
    expect(started.length).toBe(7)
    expect(started[0]).toMatchObject({
      intent: expect.stringContaining("sign-on"),
    })

    // The winning rank is recorded on every resolve — this is the drift signal.
    const resolved = result.trace.filter(
      (event) => event._tag === "TargetResolved"
    )
    expect(resolved.length).toBeGreaterThan(0)
  })

  it("captures a screenshot when a step fails", async () => {
    armFault("server-error", 4)
    await replay({ memberId: "12345" })

    const { readdir } = await import("node:fs/promises")
    const files = await readdir(evidence.runDir)

    expect(
      files.some((file) => file.startsWith("failure-") && file.endsWith(".png"))
    ).toBe(true)
  })

  it("keeps the operator password out of the trace", async () => {
    await replay({ memberId: "12345" })

    const { readFile } = await import("node:fs/promises")
    const trace = await readFile(join(evidence.runDir, "trace.jsonl"), "utf8")

    expect(trace).not.toContain("demo-pass")
  })
})
