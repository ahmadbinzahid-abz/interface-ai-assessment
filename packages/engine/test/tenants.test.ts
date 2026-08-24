import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  applyOverlay,
  decodeCapability,
  decodeOverlay,
  TargetDescriptor,
  TenantOverlay,
  type CapabilityArtifact,
} from "@workspace/contracts"
import { coreBankReadonly, makeRedactor } from "@workspace/policy"
import { ControlLease, makeWebSurface, type Surface } from "@workspace/surface"
import { Effect } from "effect"
import { chromium, type Browser, type Page } from "playwright"
import { startCoreBank, type CoreBankTestServer } from "target-corebank/testing"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { makeEvidenceWriter, type EvidenceWriter } from "../src/evidence.js"
import { runReplay } from "../src/replay/executor.js"
import { buildTestCapability, testVault } from "../src/testing/capability.js"

/**
 * One recording, two institutions.
 *
 * This is the §3.7 gate and the argument against the obvious approach. Hundreds
 * of credit unions run the same vendor product; recording a capability per
 * institution does not scale, and — worse — produces hundreds of artifacts that
 * drift apart independently, each needing its own review when the vendor ships
 * an update.
 *
 * So the capability is recorded against the *product* and a tenant that differs
 * carries a thin overlay. `riverbend` here differs in every way that breaks
 * naive automation: a different field label, a different button caption, an
 * extra layer of table nesting, and a different entry point. The overlay names
 * two controls and a URL. Nothing else in the flow is repeated.
 *
 * The test asserts the thing that actually matters — that the *same base
 * artifact object* produces a correct answer on both installs.
 */

let corebank: CoreBankTestServer
let browser: Browser
let page: Page
let surface: Surface
let lease: ControlLease
let evidence: EvidenceWriter
let evidenceRoot: string

const allowlistFor = (baseUrl: string) =>
  ({
    ...coreBankReadonly,
    allowedOrigins: [new URL(baseUrl).origin],
  }) as typeof coreBankReadonly

/**
 * Riverbend's overlay, written as a tenant integrator would write it.
 *
 * Two controls and an entry point. Everything else — the sign-on form, the
 * frameset, the accounts grid, the account-number format — belongs to the vendor
 * and is therefore not this tenant's business to restate.
 */
const riverbendOverlay = () =>
  new TenantOverlay({
    schemaVersion: "overlay/v1",
    tenant: "riverbend",
    capabilityId: "cap_lookup",
    capabilityVersion: "1.0.0",
    productVersion: "8.4.7",
    entryPoint: "{{baseUrl}}/riverbend/login",
    targets: {
      s5: new TargetDescriptor({
        description: 'textbox labelled "Member #"',
        frame: ["contentFrame"],
        role: "textbox",
        anchors: [
          {
            relation: "rightOf",
            role: "cell",
            match: { text: "Member #", exact: true },
          },
        ],
        fallbacks: [{ _tag: "controlName", name: "f1_ctl03" }],
      }),
      s6: new TargetDescriptor({
        description: 'button "Find Member"',
        frame: ["contentFrame"],
        role: "button",
        name: { text: "Find Member", exact: true },
        anchors: [],
        fallbacks: [{ _tag: "controlName", name: "f1_ctl09" }],
      }),
    },
    checkpoints: {},
    extraRecoveries: [],
  })

const replay = (artifact: CapabilityArtifact, inputs: Record<string, string>) =>
  Effect.runPromise(
    runReplay(
      {
        surface,
        evidence,
        allowlist: allowlistFor(corebank.baseUrl),
        lease,
        vault: testVault,
      },
      { artifact, inputs, baseUrl: corebank.baseUrl }
    )
  )

beforeAll(async () => {
  corebank = await startCoreBank()
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  lease = new ControlLease()
  surface = await Effect.runPromise(makeWebSurface({ page, lease }))
  evidenceRoot = await mkdtemp(join(tmpdir(), "cua-tenants-"))
})

afterAll(async () => {
  await Effect.runPromise(surface.close())
  await browser.close()
  await corebank.stop()
})

beforeEach(async () => {
  corebank.reset()
  evidence = await makeEvidenceWriter({
    root: evidenceRoot,
    runId: `tenant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    redactor: makeRedactor(),
  })
})

describe("one capability, two tenants", () => {
  it("replays against the institution it was recorded on", async () => {
    const result = await replay(buildTestCapability(), { memberId: "12345" })

    expect(result._tag).toBe("Succeeded")
    if (result._tag !== "Succeeded") return
    expect(result.outputs["savingsBalance"]).toBe("$4,812.65")
    expect(result.summary.tenant).toBeNull()
  })

  it("replays the same artifact against a different institution", async () => {
    // The same base object as the test above. Nothing is re-recorded.
    const resolved = applyOverlay(buildTestCapability(), riverbendOverlay())
    const result = await replay(resolved, { memberId: "12345" })

    expect(result._tag).toBe("Succeeded")
    if (result._tag !== "Succeeded") return

    // Riverbend labels the field "Member #", captions the button "Find Member",
    // wraps its content in an extra table and lives at a different URL. The
    // answer is the same because the member is the same.
    expect(result.outputs["savingsBalance"]).toBe("$4,812.65")

    // The run records which tenant it executed as, so a result can always be
    // traced back to exactly what ran.
    expect(result.summary.tenant).toBe("riverbend")
  })

  it("opens the tenant's own install, not the one it was recorded against", async () => {
    const resolved = applyOverlay(buildTestCapability(), riverbendOverlay())
    const result = await replay(resolved, { memberId: "12345" })

    if (result._tag !== "Succeeded") return

    /**
     * The regression this exists to prevent.
     *
     * The recording wrote its opening URL out as a literal, so an overlay that
     * changed `entryPoint` changed a field nothing read — the run signed into
     * First City and then failed on a label. It failed for the *right-looking
     * wrong reason*, which is how it survived. The step references the entry
     * point now, and the page it ended on proves which install it opened.
     */
    const observation = await Effect.runPromise(surface.observe())

    expect(observation.url).toContain("/riverbend/")
    expect(observation.url).not.toContain("/firstcity/")
  })

  it("carries a retargeted step's checkpoint with it", async () => {
    const resolved = applyOverlay(buildTestCapability(), riverbendOverlay())
    const typed = resolved.steps.find((step) => step.id === "s5")

    // The compiler gives a `type` step a checkpoint holding its own copy of the
    // descriptor. If the overlay moved one and not the other, the field would be
    // filled correctly and then fail to confirm — which reads as a broken tenant
    // rather than a half-applied overlay.
    expect(typed?.checkpoint?._tag).toBe("valueEquals")
    if (typed?.checkpoint?._tag !== "valueEquals") return
    expect(typed.checkpoint.target.description).toContain("Member #")
  })

  it("cannot add, remove or reorder steps", () => {
    const base = buildTestCapability()
    const resolved = applyOverlay(base, riverbendOverlay())

    // A tenant whose *flow* differs is not running a configured variant of this
    // capability — it needs its own recording. The schema makes expressing that
    // impossible rather than merely discouraged.
    expect(resolved.steps.map((step) => step.id)).toEqual(
      base.steps.map((step) => step.id)
    )
  })
})

describe("the shipped overlay", () => {
  it("decodes, and names the capability it specialises", async () => {
    const raw = await readFile(
      join(
        process.cwd(),
        "capabilities",
        "overlays",
        "lookupMemberSavingsBalance@1.0.0.riverbend.json"
      ),
      "utf8"
    )

    const overlay = await Effect.runPromise(decodeOverlay(JSON.parse(raw)))

    expect(overlay.tenant).toBe("riverbend")
    expect(overlay.capabilityVersion).toBe("1.0.0")
    // Thin by construction. If a tenant needs more than a handful of entries,
    // that is the signal it is not the same flow.
    expect(Object.keys(overlay.targets).length).toBeLessThanOrEqual(4)
  })

  it("applies cleanly to the shipped capability", async () => {
    const raw = await readFile(
      join(
        process.cwd(),
        "capabilities",
        "lookupMemberSavingsBalance@1.0.0.json"
      ),
      "utf8"
    )
    const base = await Effect.runPromise(decodeCapability(JSON.parse(raw)))

    const overlayRaw = await readFile(
      join(
        process.cwd(),
        "capabilities",
        "overlays",
        "lookupMemberSavingsBalance@1.0.0.riverbend.json"
      ),
      "utf8"
    )
    const overlay = await Effect.runPromise(
      decodeOverlay(JSON.parse(overlayRaw))
    )

    // The overlay must name the capability it specialises, or it would silently
    // apply to the wrong one.
    expect(overlay.capabilityId).toBe(base.id)

    const resolved = applyOverlay(base, overlay)

    expect(resolved.target.tenant).toBe("riverbend")
    expect(resolved.target.entryPoint).toContain("/riverbend/")
    expect(resolved.steps.length).toBe(base.steps.length)
  })
})
