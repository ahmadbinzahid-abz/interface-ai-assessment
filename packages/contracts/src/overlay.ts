import { Schema } from "effect"

import {
  CapabilityArtifact,
  Recovery,
  Step,
  TargetBinding,
} from "./capability.js"
import { Condition } from "./condition.js"
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

    /**
     * Replacement checkpoints, keyed by step id.
     *
     * Needed because a tenant's *vocabulary* leaks into assertions as well as
     * into targets: a step that checks for the text "Open Sub-Account" is
     * checking for something this tenant calls "New Sub Account". Retargeting
     * alone cannot fix that, because the assertion is about words on a screen
     * rather than about a control.
     *
     * A checkpoint that merely asserts *the control the overlay just retargeted*
     * needs no entry here — that one follows the target automatically.
     */
    checkpoints: Schema.optionalWith(
      Schema.Record({ key: Schema.String, value: Condition }),
      { default: () => ({}) }
    ),

    /** The tenant's own wording for "it worked", when the base one is not true here. */
    successCondition: Schema.optional(Condition),

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
    // Constructed, not spread into a literal: these are schema classes and carry
    // their own validation, so a plain object looks right and is rejected.
    target: new TargetBinding({
      ...base.target,
      tenant: overlay.tenant,
      productVersion: overlay.productVersion ?? base.target.productVersion,
      entryPoint: overlay.entryPoint ?? base.target.entryPoint,
    }),
    steps: base.steps.map((step) => {
      const replacement = overlay.targets[step.id]
      const checkpoint = overlay.checkpoints[step.id]

      if (!replacement && !checkpoint) return step

      return new Step({
        ...step,
        action: replacement ? retarget(step.action, replacement) : step.action,
        checkpoint:
          checkpoint ??
          (replacement
            ? retargetCheckpoint(step, replacement)
            : step.checkpoint),
      })
    }),
    successCondition: overlay.successCondition ?? base.successCondition,
    recoveries: [...base.recoveries, ...overlay.extraRecoveries],
  })

/**
 * A checkpoint that asserts the control the overlay just moved has to move with
 * it.
 *
 * The compiler gives every `type` step a `valueEquals` checkpoint carrying its
 * *own copy* of the action's descriptor. An overlay that renamed "Member Number"
 * to "Member #" would otherwise retarget the action and leave the assertion
 * looking for the old label — so the field would be filled correctly and the
 * step would then fail to confirm it. That failure looks like a broken tenant
 * rather than a half-applied overlay, which is the worst way for it to present.
 *
 * The rule is narrow on purpose: only a descriptor *identical to the one being
 * replaced* follows. A checkpoint about some other control is left alone, and a
 * tenant that needs it changed says so explicitly.
 */
const retargetCheckpoint = (
  step: Step,
  replacement: TargetDescriptor
): Condition | undefined => {
  const checkpoint = step.checkpoint
  if (!checkpoint) return undefined

  const original =
    "target" in step.action ? step.action.target.description : undefined
  if (original === undefined) return checkpoint

  const follows = (target: TargetDescriptor) =>
    target.description === original ? replacement : target

  switch (checkpoint._tag) {
    case "valueEquals":
    case "elementPresent":
    case "elementAbsent":
      return { ...checkpoint, target: follows(checkpoint.target) }
    default:
      return checkpoint
  }
}

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
