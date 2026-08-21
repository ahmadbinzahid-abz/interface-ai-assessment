import { Schema } from "effect"

import { CapabilityArtifact, Recovery } from "./capability.js"
import { TargetDescriptor } from "./targeting.js"

/**
 * Per-tenant specialisation of a shared capability.
 *
 * Hundreds of institutions run the same vendor product. Re-recording a
 * capability per tenant does not scale and, worse, produces hundreds of
 * artifacts that drift apart independently. So a capability is recorded once
 * against the *product*, and a tenant that differs carries a thin overlay
 * naming only what differs.
 *
 * The overlay is deliberately narrow. It can change where the flow starts, how a
 * specific control is found, and what interstitials that tenant throws — the
 * things that genuinely vary between deployments of one product. It cannot add,
 * remove or reorder steps, because a tenant whose *flow* differs is not running
 * a configured variant of the same capability, it needs its own recording. Making
 * that impossible to express keeps the distinction honest.
 */
export class TenantOverlay extends Schema.Class<TenantOverlay>("TenantOverlay")(
  {
    schemaVersion: Schema.Literal("overlay/v1"),
    tenant: Schema.String,
    /** Which capability, and which major version of it, this overlay applies to. */
    capabilityId: Schema.String,
    capabilityVersion: Schema.String,
    productVersion: Schema.optional(Schema.String),

    /** This tenant's install lives somewhere else. */
    entryPoint: Schema.optional(Schema.String),

    /**
     * Replacement descriptors, keyed by step id. Used when a tenant renames a
     * field ("Member Number" vs "Member #") so the recorded accessible name no
     * longer matches.
     */
    targets: Schema.optionalWith(
      Schema.Record({ key: Schema.String, value: TargetDescriptor }),
      { default: () => ({}) }
    ),

    /** Interstitials and notices peculiar to this tenant. Appended, not replaced. */
    extraRecoveries: Schema.optionalWith(Schema.Array(Recovery), {
      default: () => [],
    }),

    notes: Schema.optional(Schema.String),
  }
) {}

export const decodeOverlay = Schema.decodeUnknown(TenantOverlay)

/**
 * Resolve a base capability against a tenant overlay.
 *
 * Deterministic and total: same inputs, same artifact, every time. Replay records
 * both versions so a run can always be traced back to exactly what executed.
 */
export const applyOverlay = (
  base: CapabilityArtifact,
  overlay: TenantOverlay
): CapabilityArtifact =>
  new CapabilityArtifact({
    ...base,
    target: {
      ...base.target,
      tenant: overlay.tenant,
      productVersion: overlay.productVersion ?? base.target.productVersion,
      entryPoint: overlay.entryPoint ?? base.target.entryPoint,
    },
    steps: base.steps.map((step) => {
      const replacement = overlay.targets[step.id]
      if (!replacement) return step

      return { ...step, action: retarget(step.action, replacement) }
    }),
    recoveries: [...base.recoveries, ...overlay.extraRecoveries],
  })

/**
 * Swap the descriptor on whichever actions carry one. Actions without a target
 * (`navigate`, `press`, `reauth`) are returned unchanged — an overlay that names
 * such a step is a no-op rather than an error, because the alternative is
 * failing a whole tenant's replay over a stale overlay entry.
 */
const retarget = (
  action: CapabilityArtifact["steps"][number]["action"],
  target: TargetDescriptor
): CapabilityArtifact["steps"][number]["action"] => {
  switch (action._tag) {
    case "click":
    case "type":
    case "select":
    case "extract":
      return { ...action, target }
    default:
      return action
  }
}
