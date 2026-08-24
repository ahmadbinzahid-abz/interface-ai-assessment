import { describe, expect, it } from "vitest"

import {
  CapabilityArtifact,
  Health,
  InputParam,
  OutputField,
  PolicyBinding,
  Provenance,
  Recovery,
  Step,
  TargetBinding,
} from "./capability.js"
import { applyOverlay, TenantOverlay } from "./overlay.js"
import { TargetDescriptor } from "./targeting.js"

/**
 * Reusing one recording across institutions running the same vendor product.
 *
 * The overlay is how a capability recorded once is specialised per tenant instead
 * of being re-recorded hundreds of times. What it is *not* allowed to do matters
 * as much as what it is.
 */

const descriptor = (description: string, label: string) =>
  new TargetDescriptor({
    description,
    frame: ["contentFrame"],
    role: "textbox",
    anchors: [
      {
        relation: "rightOf",
        role: "cell",
        match: { text: label, exact: true },
      },
    ],
    fallbacks: [],
  })

const base = () =>
  new CapabilityArtifact({
    schemaVersion: "capability/v1",
    id: "cap_lookup",
    name: "lookupMemberSavingsBalance",
    version: "1.0.0",
    status: "approved",
    description: "Look up a member and read their savings balance.",
    target: new TargetBinding({
      surfaceKind: "legacy-web",
      vendorProduct: "corebank",
      productVersion: "8.4.1",
      tenant: null,
      entryPoint: "{{baseUrl}}/firstcity/login",
    }),
    inputs: [
      new InputParam({
        name: "memberId",
        type: "string",
        description: "Member number.",
        required: true,
        sensitivity: "identifier",
      }),
    ],
    outputs: [
      new OutputField({
        name: "savingsBalance",
        type: "string",
        format: "currency-usd",
        description: "Balance.",
        sensitivity: "financial",
      }),
    ],
    outcomes: [],
    steps: [
      new Step({
        id: "s1",
        intent: "Open sign-on.",
        action: { _tag: "navigate", url: { _tag: "literal", value: "/login" } },
        riskClass: "safe",
        timeoutMs: 10_000,
      }),
      new Step({
        id: "s2",
        intent: "Enter the member number.",
        // First City calls it "Member Number"; Riverbend calls it "Member #".
        action: {
          _tag: "type",
          target: descriptor("Member number field", "Member Number"),
          value: { _tag: "param", name: "memberId" },
          clearFirst: true,
        },
        riskClass: "safe",
        timeoutMs: 10_000,
      }),
    ],
    recoveries: [],
    successCondition: { _tag: "textPresent", text: "Current Balance" },
    policy: new PolicyBinding({
      allowlistRef: "corebank-readonly",
      maxRiskClass: "safe",
      requiresApproval: false,
    }),
    provenance: new Provenance({
      discoveredBy: "test",
      discoveredAt: "2026-08-21T00:00:00.000Z",
      runId: "run",
      transcriptDigest: "sha256:test",
    }),
    health: new Health({ replays: 0, successes: 0, fallbackHitRate: {} }),
  })

const riverbend = (
  fields: Partial<ConstructorParameters<typeof TenantOverlay>[0]> = {}
) =>
  new TenantOverlay({
    schemaVersion: "overlay/v1",
    tenant: "riverbend",
    capabilityId: "cap_lookup",
    capabilityVersion: "1.0.0",
    targets: {},
    extraRecoveries: [],
    ...fields,
  })

describe("applying a tenant overlay", () => {
  it("stamps the tenant onto an artifact recorded against the product", () => {
    const resolved = applyOverlay(base(), riverbend())

    expect(base().target.tenant).toBeNull()
    expect(resolved.target.tenant).toBe("riverbend")
    // The capability's identity does not change; only its binding does.
    expect(resolved.id).toBe("cap_lookup")
    expect(resolved.name).toBe("lookupMemberSavingsBalance")
  })

  it("points the flow at this institution's install", () => {
    const resolved = applyOverlay(
      base(),
      riverbend({ entryPoint: "{{baseUrl}}/riverbend/login" })
    )

    expect(resolved.target.entryPoint).toBe("{{baseUrl}}/riverbend/login")
  })

  it("records the tenant's own product version", () => {
    const resolved = applyOverlay(
      base(),
      riverbend({ productVersion: "8.4.7" })
    )

    expect(resolved.target.productVersion).toBe("8.4.7")
  })

  /**
   * The case the whole mechanism exists for: same vendor product, different
   * label on the field. Without an override the recorded anchor finds nothing.
   */
  it("retargets a single step without touching the others", () => {
    const resolved = applyOverlay(
      base(),
      riverbend({
        targets: { s2: descriptor("Member number field", "Member #") },
      })
    )

    const step = resolved.steps.find((candidate) => candidate.id === "s2")
    if (step?.action._tag !== "type") throw new Error("expected a type step")

    expect(step.action.target.anchors[0]?.match.text).toBe("Member #")
    // The value reference survives — an overlay changes *where*, never *what*.
    expect(step.action.value).toEqual({ _tag: "param", name: "memberId" })

    expect(resolved.steps[0]).toEqual(base().steps[0])
  })

  it("appends this tenant's interstitials rather than replacing the base ones", () => {
    const extra = new Recovery({
      name: "riverbend-survey-popup",
      when: { _tag: "textPresent", text: "How are we doing?" },
      do: [],
      retriesStep: false,
      maxPerRun: 1,
    })

    const resolved = applyOverlay(
      base(),
      riverbend({ extraRecoveries: [extra] })
    )

    expect(resolved.recoveries.map((recovery) => recovery.name)).toEqual([
      "riverbend-survey-popup",
    ])
  })

  it("leaves the base artifact untouched, so one recording serves every tenant", () => {
    const original = base()
    applyOverlay(
      original,
      riverbend({ targets: { s2: descriptor("x", "Member #") } })
    )

    expect(original.target.tenant).toBeNull()
    const step = original.steps.find((candidate) => candidate.id === "s2")
    if (step?.action._tag !== "type") throw new Error("expected a type step")
    expect(step.action.target.anchors[0]?.match.text).toBe("Member Number")
  })

  it("ignores an override naming a step that carries no target", () => {
    // A stale overlay entry should not fail a whole tenant's replay.
    const resolved = applyOverlay(
      base(),
      riverbend({ targets: { s1: descriptor("nonsense", "x") } })
    )

    expect(resolved.steps[0]?.action).toEqual({
      _tag: "navigate",
      url: { _tag: "literal", value: "/login" },
    })
  })

  it("is deterministic — the same inputs merge to the same artifact", () => {
    const overlay = riverbend({ targets: { s2: descriptor("f", "Member #") } })

    expect(JSON.stringify(applyOverlay(base(), overlay))).toBe(
      JSON.stringify(applyOverlay(base(), overlay))
    )
  })
})
