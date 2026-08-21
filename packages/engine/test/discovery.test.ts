import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { coreBankReadonly, makeRedactor } from "@workspace/policy"
import { ControlLease, makeWebSurface, type Surface } from "@workspace/surface"
import { Effect } from "effect"
import { chromium, type Browser, type Page } from "playwright"
import { startCoreBank, type CoreBankTestServer } from "target-corebank/testing"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { compileCapability } from "../src/discovery/compile.js"
import { runDiscovery } from "../src/discovery/loop.js"
import type { DiscoveryParameter } from "../src/discovery/types.js"
import { makeEvidenceWriter, type EvidenceWriter } from "../src/evidence.js"
import type { ModelToolCall } from "../src/model.js"
import {
  makeScriptedModel,
  refMatching,
  type ScriptStep,
} from "../src/testing/scripted-model.js"

/**
 * The discovery pipeline end to end, against the real application in a real
 * browser, with the model scripted.
 *
 * Scripting the model is what makes this a test rather than a demo: the parts
 * being exercised — the policy chokepoint, step recording, descriptor synthesis,
 * parameterisation and compilation — are ours, and they should not need a paid
 * API call or produce a different answer every run. The real Gemini client is a
 * thin translation layer over the same interface.
 */

let corebank: CoreBankTestServer
let browser: Browser
let page: Page
let surface: Surface
let lease: ControlLease
let evidence: EvidenceWriter
let evidenceRoot: string

const memberId: DiscoveryParameter = {
  name: "memberId",
  value: "12345",
  description: "The member number to look up.",
  sensitivity: "identifier",
}

const call = (name: string, args: Record<string, unknown>): ModelToolCall => ({
  name,
  args,
})

/** The sign-on steps, shared by every scenario. */
const signOnScript = (baseUrl: string): ScriptStep[] => [
  [
    call("navigate", {
      url: `${baseUrl}/firstcity/login`,
      why: "Open the servicing desk sign-on.",
    }),
  ],
  ({ screen }) => [
    call("type", {
      ref: refMatching(screen, /labelled "Operator ID"/),
      value: "teller01",
      why: "Enter the operator id.",
    }),
  ],
  ({ screen }) => [
    call("type", {
      ref: refMatching(screen, /labelled "Password"/),
      value: "demo-pass",
      why: "Enter the operator password.",
    }),
  ],
  ({ screen }) => [
    call("click", {
      ref: refMatching(screen, /button.*"Sign On"/),
      why: "Sign on to reach the servicing desk.",
      expect: "Member Search",
    }),
  ],
]

const searchScript = (): ScriptStep[] => [
  ({ screen }) => [
    call("type", {
      ref: refMatching(screen, /labelled "Member Number"/),
      value: memberId.value,
      why: "Enter the member number being looked up.",
    }),
  ],
  ({ screen }) => [
    call("click", {
      ref: refMatching(screen, /button.*"Search"/),
      why: "Run the member search.",
      expect: "Current Balance",
    }),
  ],
]

beforeAll(async () => {
  corebank = await startCoreBank()
  browser = await chromium.launch()
  evidenceRoot = await mkdtemp(join(tmpdir(), "cua-evidence-"))
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await corebank.stop()
})

beforeEach(async () => {
  corebank.reset()
  page = await browser.newPage()

  // Deliberately left unclaimed: the discovery run acquires it itself.
  lease = new ControlLease()
  surface = await Effect.runPromise(makeWebSurface({ page, lease }))

  evidence = await makeEvidenceWriter({
    root: evidenceRoot,
    runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    redactor: makeRedactor({ values: [memberId.value] }),
  })
})

const allowlistForTest = {
  ...coreBankReadonly,
  // The fixture runs on an ephemeral port, so the origin is decided at runtime.
  allowedOrigins: [] as string[],
}

const withOrigin = (baseUrl: string) =>
  ({
    ...allowlistForTest,
    allowedOrigins: [new URL(baseUrl).origin],
  }) as typeof coreBankReadonly

describe("a successful discovery run", () => {
  it("records the flow, extracts the output, and compiles a capability", async () => {
    const script: ScriptStep[] = [
      ...signOnScript(corebank.baseUrl),
      ...searchScript(),
      ({ screen }) => [
        call("extract", {
          ref: refMatching(screen, /cell.*"\$4,812\.65"/),
          output: "savingsBalance",
          format: "currency-usd",
          description: "The member's current savings balance.",
          why: "The goal is to read the savings balance.",
        }),
      ],
      [
        call("finish", {
          summary: "Look up a member by number and read their savings balance.",
          successText: "Current Balance",
        }),
      ],
    ]

    const run = await Effect.runPromise(
      runDiscovery(
        {
          surface,
          model: makeScriptedModel({ script }),
          evidence,
          allowlist: withOrigin(corebank.baseUrl),
          lease,
        },
        {
          goal: "Look up member 12345 and read their current savings balance.",
          entryPoint: `${corebank.baseUrl}/firstcity/login`,
          parameters: [memberId],
        }
      )
    )

    expect(run.result._tag).toBe("Completed")
    expect(run.steps.length).toBeGreaterThanOrEqual(6)

    const balance = run.outputs.find(
      (output) => output.name === "savingsBalance"
    )
    expect(balance?.sampleValue).toContain("4,812.65")
  })

  it("records the member number as a parameter, never as a literal", async () => {
    const script: ScriptStep[] = [
      ...signOnScript(corebank.baseUrl),
      ...searchScript(),
      [
        call("finish", {
          summary: "Look up a member.",
          successText: "Current Balance",
        }),
      ],
    ]

    const run = await Effect.runPromise(
      runDiscovery(
        {
          surface,
          model: makeScriptedModel({ script }),
          evidence,
          allowlist: withOrigin(corebank.baseUrl),
          lease,
        },
        {
          goal: "Look up member 12345.",
          entryPoint: `${corebank.baseUrl}/firstcity/login`,
          parameters: [memberId],
        }
      )
    )

    const typedMemberId = run.steps.find(
      (step) =>
        step.action._tag === "type" && step.action.value._tag === "param"
    )

    expect(typedMemberId).toBeDefined()
    if (typedMemberId?.action._tag !== "type")
      throw new Error("expected a type step")
    expect(typedMemberId.action.value).toEqual({
      _tag: "param",
      name: "memberId",
    })

    // The password was not a declared parameter, so it stays a literal here — and
    // the compiler is what must never let it reach a committed artifact.
    const serialised = JSON.stringify(run.steps)
    expect(serialised).not.toContain('"literal","value":"12345"')
  })

  it("synthesises descriptors that survive without a name or a test id", async () => {
    const script: ScriptStep[] = [
      ...signOnScript(corebank.baseUrl),
      ...searchScript(),
      [
        call("finish", {
          summary: "Look up a member.",
          successText: "Current Balance",
        }),
      ],
    ]

    const run = await Effect.runPromise(
      runDiscovery(
        {
          surface,
          model: makeScriptedModel({ script }),
          evidence,
          allowlist: withOrigin(corebank.baseUrl),
          lease,
        },
        {
          goal: "Look up member 12345.",
          entryPoint: `${corebank.baseUrl}/firstcity/login`,
          parameters: [memberId],
        }
      )
    )

    const typeStep = run.steps.find(
      (step) =>
        step.action._tag === "type" && step.action.value._tag === "param"
    )
    if (typeStep?.action._tag !== "type")
      throw new Error("expected a type step")

    const target = typeStep.action.target

    // The field has no accessible name, so the recording must lean on the label
    // beside it — and carry the legacy control name as a safety net.
    expect(target.anchors.length).toBeGreaterThan(0)
    expect(target.anchors[0]).toMatchObject({
      relation: "rightOf",
      match: { text: "Member Number" },
    })
    expect(
      target.fallbacks.some((fallback) => fallback._tag === "controlName")
    ).toBe(true)
    expect(target.frame).toEqual(["contentFrame"])
  })
})

describe("compiling the artifact", () => {
  it("produces a reviewable draft with a real contract", async () => {
    const script: ScriptStep[] = [
      ...signOnScript(corebank.baseUrl),
      ...searchScript(),
      ({ screen }) => [
        call("extract", {
          ref: refMatching(screen, /cell.*"\$4,812\.65"/),
          output: "savingsBalance",
          format: "currency-usd",
          description: "The member's current savings balance.",
          why: "The goal is to read the savings balance.",
        }),
      ],
      [
        call("declare_outcome", {
          tag: "MemberNotFound",
          description: "No member exists with that number.",
          whenText: "No member found for",
        }),
      ],
      [
        call("finish", {
          summary: "Look up a member by number and read their savings balance.",
          successText: "Current Balance",
        }),
      ],
    ]

    const run = await Effect.runPromise(
      runDiscovery(
        {
          surface,
          model: makeScriptedModel({ script }),
          evidence,
          allowlist: withOrigin(corebank.baseUrl),
          lease,
        },
        {
          goal: "Look up member 12345 and read their savings balance.",
          entryPoint: `${corebank.baseUrl}/firstcity/login`,
          parameters: [memberId],
        }
      )
    )

    const artifact = compileCapability({
      run,
      capabilityId: "cap_member_savings_balance",
      name: "lookupMemberSavingsBalance",
      version: "1.0.0",
      vendorProduct: "corebank",
      productVersion: "8.4.1",
      surfaceKind: "legacy-web",
      entryPoint: "{{baseUrl}}/firstcity/login",
      parameters: [memberId],
      allowlistRef: "corebank-readonly",
      transcriptDigest: "sha256:test",
    })

    // A model wrote it and nobody has read it yet.
    expect(artifact.status).toBe("draft")

    expect(artifact.inputs.map((input) => input.name)).toEqual(["memberId"])
    expect(artifact.inputs[0]?.pattern).toBe("^\\d+$")

    expect(artifact.outputs.map((output) => output.name)).toContain(
      "savingsBalance"
    )
    expect(artifact.outputs[0]?.sensitivity).toBe("financial")

    expect(artifact.outcomes.map((outcome) => outcome.tag)).toContain(
      "MemberNotFound"
    )

    // Every step explains itself to a reviewer.
    expect(artifact.steps.every((step) => step.intent.trim().length > 0)).toBe(
      true
    )

    expect(artifact.successCondition).toEqual({
      _tag: "textPresent",
      text: "Current Balance",
    })
    expect(artifact.target.tenant).toBeNull()
  })

  it("refuses to compile a run that did not complete", async () => {
    const run = await Effect.runPromise(
      runDiscovery(
        {
          surface,
          model: makeScriptedModel({
            script: [[call("give_up", { reason: "nope" })]],
          }),
          evidence,
          allowlist: withOrigin(corebank.baseUrl),
          lease,
        },
        {
          goal: "Anything.",
          entryPoint: `${corebank.baseUrl}/firstcity/login`,
          parameters: [],
        }
      )
    )

    expect(run.result._tag).toBe("GaveUp")
    expect(() =>
      compileCapability({
        run,
        capabilityId: "x",
        name: "x",
        version: "1.0.0",
        vendorProduct: "corebank",
        surfaceKind: "legacy-web",
        entryPoint: "x",
        parameters: [],
        allowlistRef: "corebank-readonly",
        transcriptDigest: "sha256:test",
      })
    ).toThrow(/completed/i)
  })
})

describe("the policy chokepoint", () => {
  it("refuses an irreversible action and tells the model to escalate", async () => {
    const script: ScriptStep[] = [
      ...signOnScript(corebank.baseUrl),
      ...searchScript(),
      ({ screen }) => [
        call("click", {
          ref: refMatching(screen, /button.*"Close Account"/),
          why: "Trying to close the account.",
        }),
      ],
      ({ lastResults }) => {
        const refusal = lastResults.find((result) => result["refused"] === true)
        // The refusal has to reach the model, or it cannot react to it.
        if (!refusal)
          throw new Error(
            `expected a refusal, got ${JSON.stringify(lastResults)}`
          )
        return [call("escalate", { reason: String(refusal["reason"]) })]
      },
    ]

    const run = await Effect.runPromise(
      runDiscovery(
        {
          surface,
          model: makeScriptedModel({ script }),
          evidence,
          allowlist: withOrigin(corebank.baseUrl),
          lease,
        },
        {
          goal: "Close member 12345's account.",
          entryPoint: `${corebank.baseUrl}/firstcity/login`,
          parameters: [memberId],
        }
      )
    )

    expect(run.result._tag).toBe("Escalated")
    if (run.result._tag !== "Escalated") return
    expect(run.result.reason).toContain("irreversible")

    // Refused means not performed: no step was recorded for it.
    expect(
      run.steps.some((step) => step.intent.includes("close the account"))
    ).toBe(false)
  })

  it("refuses to navigate off the allowlisted origin", async () => {
    const script: ScriptStep[] = [
      [
        call("navigate", {
          url: "https://example.com/",
          why: "Going somewhere else.",
        }),
      ],
      ({ lastResults }) => [
        call("give_up", {
          reason: String(lastResults[0]?.["reason"] ?? "no reason given"),
        }),
      ],
    ]

    const run = await Effect.runPromise(
      runDiscovery(
        {
          surface,
          model: makeScriptedModel({ script }),
          evidence,
          allowlist: withOrigin(corebank.baseUrl),
          lease,
        },
        {
          goal: "Leave.",
          entryPoint: `${corebank.baseUrl}/firstcity/login`,
          parameters: [],
        }
      )
    )

    expect(run.result._tag).toBe("GaveUp")
    if (run.result._tag !== "GaveUp") return
    expect(run.result.reason).toContain("not on the allowlist")
    expect(run.steps).toHaveLength(0)
  })

  it("refuses the fault-injection hooks, which are not application surface", async () => {
    const script: ScriptStep[] = [
      [
        call("navigate", {
          url: `${corebank.baseUrl}/__control/state`,
          why: "Peeking.",
        }),
      ],
      ({ lastResults }) => [
        call("give_up", { reason: String(lastResults[0]?.["rule"] ?? "none") }),
      ],
    ]

    const run = await Effect.runPromise(
      runDiscovery(
        {
          surface,
          model: makeScriptedModel({ script }),
          evidence,
          allowlist: withOrigin(corebank.baseUrl),
          lease,
        },
        {
          goal: "Peek.",
          entryPoint: `${corebank.baseUrl}/firstcity/login`,
          parameters: [],
        }
      )
    )

    if (run.result._tag !== "GaveUp") throw new Error("expected GaveUp")
    expect(run.result.reason).toBe("deniedPaths")
  })
})

describe("stale control references", () => {
  it("refuses a second page-changing call in the same turn", async () => {
    const script: ScriptStep[] = [
      ...signOnScript(corebank.baseUrl),
      ({ screen }) => [
        call("type", {
          ref: refMatching(screen, /labelled "Member Number"/),
          value: memberId.value,
          why: "Enter the member number.",
        }),
        // Same turn, but the screen has already changed underneath this one.
        call("click", { ref: 999, why: "Click something stale." }),
      ],
      ({ lastResults }) => [
        call("give_up", {
          reason: String(lastResults[1]?.["reason"] ?? "none"),
        }),
      ],
    ]

    const run = await Effect.runPromise(
      runDiscovery(
        {
          surface,
          model: makeScriptedModel({ script }),
          evidence,
          allowlist: withOrigin(corebank.baseUrl),
          lease,
        },
        {
          goal: "Look up a member.",
          entryPoint: `${corebank.baseUrl}/firstcity/login`,
          parameters: [memberId],
        }
      )
    )

    if (run.result._tag !== "GaveUp") throw new Error("expected GaveUp")
    expect(run.result.reason).toContain("stale")
  })
})

describe("evidence", () => {
  it("writes a trace that says what happened and why it was allowed", async () => {
    const script: ScriptStep[] = [
      ...signOnScript(corebank.baseUrl),
      [call("finish", { summary: "Signed on.", successText: "Member Search" })],
    ]

    await Effect.runPromise(
      runDiscovery(
        {
          surface,
          model: makeScriptedModel({ script }),
          evidence,
          allowlist: withOrigin(corebank.baseUrl),
          lease,
        },
        {
          goal: "Sign on.",
          entryPoint: `${corebank.baseUrl}/firstcity/login`,
          parameters: [],
        }
      )
    )

    const trace = await readFile(join(evidence.runDir, "trace.jsonl"), "utf8")
    const events = trace
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(events[0]?.["kind"]).toBe("RunStarted")
    expect(events.some((event) => event["kind"] === "PolicyDecision")).toBe(
      true
    )
    expect(events.at(-1)?.["kind"]).toBe("RunFinished")
  })

  it("redacts declared sensitive values on the way to disk", async () => {
    await evidence.event({
      kind: "Test",
      note: `member ${memberId.value} has SSN 123-45-6789`,
    })

    const trace = await readFile(join(evidence.runDir, "trace.jsonl"), "utf8")

    expect(trace).not.toContain("123-45-6789")
    expect(trace).not.toContain(memberId.value)
    expect(trace).toContain("[redacted:")
  })
})
