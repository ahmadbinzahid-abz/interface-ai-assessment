import { Schema } from "effect"

import { Action, RiskClass } from "./action.js"
import { Condition } from "./condition.js"
import { Sensitivity, ValueFormat, ValueType } from "./values.js"

/**
 * A capability artifact: the compiled output of one successful discovery run, and
 * the unit an AI agent invokes in production.
 *
 * It is deliberately a *contract*, not a recording. A step list alone tells you
 * what was clicked once; a contract tells a caller what the capability needs,
 * what it returns, which non-success answers are legitimate, and how to know it
 * actually worked. Everything below exists to answer one of those four questions.
 */

// ── What surface this runs against ───────────────────────────────────────

/**
 * The kind of surface, which selects the adapter. The artifact does not say
 * *how* to drive it — that is the adapter's job — only which family of surface
 * the recorded descriptors were captured against.
 */
export const SurfaceKind = Schema.Literal("web", "legacy-web", "desktop")
export type SurfaceKind = typeof SurfaceKind.Type

export class TargetBinding extends Schema.Class<TargetBinding>("TargetBinding")(
  {
    surfaceKind: SurfaceKind,
    /**
     * The vendor product, shared by every institution running it. This is the key
     * that makes cross-tenant reuse possible: capabilities are recorded against a
     * *product*, and specialised per tenant by an overlay.
     */
    vendorProduct: Schema.String,
    productVersion: Schema.optional(Schema.String),
    /** Null on a base artifact. Set only on a tenant-specialised copy. */
    tenant: Schema.optionalWith(Schema.NullOr(Schema.String), {
      default: () => null,
    }),
    /** May contain `{{baseUrl}}`, resolved per tenant at replay time. */
    entryPoint: Schema.String,
  }
) {}

// ── The calling contract ─────────────────────────────────────────────────

export class InputParam extends Schema.Class<InputParam>("InputParam")({
  name: Schema.String,
  type: ValueType,
  description: Schema.String,
  required: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  /** Validated before the browser is even opened, so bad input never acts. */
  pattern: Schema.optional(Schema.String),
  sensitivity: Schema.optionalWith(Sensitivity, {
    default: () => "none" as const,
  }),
}) {}

export class OutputField extends Schema.Class<OutputField>("OutputField")({
  name: Schema.String,
  type: ValueType,
  format: Schema.optionalWith(ValueFormat, { default: () => "text" as const }),
  description: Schema.String,
  sensitivity: Schema.optionalWith(Sensitivity, {
    default: () => "none" as const,
  }),
}) {}

/**
 * A non-success answer the caller is entitled to receive.
 *
 * This is the single most important field in the schema. "No such member" is a
 * legitimate result of looking up a member, not a malfunction — conflating the
 * two is what turns a working integration into pager noise. Declaring outcomes
 * here means the replay engine can *detect* them and return them as typed data,
 * rather than throwing and leaving the caller to parse an error string.
 */
export class DeclaredOutcome extends Schema.Class<DeclaredOutcome>(
  "DeclaredOutcome"
)({
  /** Discriminant the caller matches on, e.g. `MemberNotFound`. */
  tag: Schema.String,
  description: Schema.String,
  detect: Condition,
  /** Outputs that can still be populated when this outcome fires. */
  partialOutputs: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),
}) {}

// ── The flow ─────────────────────────────────────────────────────────────

export class Step extends Schema.Class<Step>("Step")({
  id: Schema.String,
  /**
   * Why this step exists, in English. Not decoration: this is what makes an
   * artifact reviewable in a pull request by someone who was not there when it
   * was recorded.
   */
  intent: Schema.String,
  action: Action,
  riskClass: Schema.optionalWith(RiskClass, { default: () => "safe" as const }),
  /**
   * Asserted after the action. A step without a checkpoint is a step that
   * assumes its click worked, which is the most common way a replay reports
   * success while having done nothing.
   */
  checkpoint: Schema.optional(Condition),
  timeoutMs: Schema.optionalWith(Schema.Number, { default: () => 10_000 }),
  /** How long this took during discovery. Informs timeouts and drift detection. */
  observedMs: Schema.optional(Schema.Number),
}) {}

/**
 * A known, bounded response to a known runtime condition.
 *
 * Recoveries are invisible to the caller — they are the middle layer between "a
 * legitimate business outcome" and "a hard failure". Every application is going
 * to throw an interstitial or expire a session eventually; handling those
 * silently but *auditably* is the difference between a capability that works in
 * production and one that works in a demo.
 */
export class Recovery extends Schema.Class<Recovery>("Recovery")({
  name: Schema.String,
  when: Condition,
  do: Schema.Array(Action),
  /**
   * Whether the interrupted step must be performed again afterwards.
   *
   * The two kinds of recovery are genuinely different. Dismissing an
   * interstitial *clears an obstruction*: the step's action already happened and
   * re-running it would be wrong — a "Sign On" click that succeeded before the
   * notice appeared cannot be repeated, because there is no sign-on screen any
   * more. Re-authenticating *restores lost context*: whatever the step did was
   * thrown away with the session, so it has to be redone.
   *
   * Defaulting to false keeps the safer of the two: re-running an action that
   * already took effect is how a replay submits a form twice.
   */
  retriesStep: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  /** Bounded, so a recovery loop cannot become an infinite one. */
  maxPerRun: Schema.optionalWith(Schema.Number, { default: () => 2 }),
}) {}

// ── Governance ───────────────────────────────────────────────────────────

/**
 * Unattended replay is gated on approval. A freshly discovered capability is a
 * `draft`: a model wrote it, nobody has read it, and it should not be moving
 * money on a schedule.
 */
export const CapabilityStatus = Schema.Literal(
  "draft",
  "candidate",
  "approved",
  "deprecated"
)
export type CapabilityStatus = typeof CapabilityStatus.Type

export class PolicyBinding extends Schema.Class<PolicyBinding>("PolicyBinding")(
  {
    /** Names an allowlist in policy config rather than inlining it. */
    allowlistRef: Schema.String,
    /** Replay refuses any step above this class. */
    maxRiskClass: Schema.optionalWith(RiskClass, {
      default: () => "safe" as const,
    }),
    requiresApproval: Schema.optionalWith(Schema.Boolean, {
      default: () => false,
    }),
  }
) {}

export class Provenance extends Schema.Class<Provenance>("Provenance")({
  discoveredBy: Schema.String,
  discoveredAt: Schema.String,
  runId: Schema.String,
  /**
   * A digest, never the transcript. A discovery transcript contains whatever the
   * model saw on screen — which in this domain is regulated customer data.
   */
  transcriptDigest: Schema.String,
  promptVersion: Schema.optional(Schema.String),
}) {}

/**
 * Replay telemetry, written back after each run.
 *
 * `fallbackHitRate` is the drift alarm. A step that used to resolve by role and
 * now resolves by its CSS fallback still passes, but it is telling you this
 * tenant's UI has moved — which is how you find drift before it becomes an
 * outage, and how you know which steps need a tenant overlay.
 */
export class Health extends Schema.Class<Health>("Health")({
  replays: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  successes: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  lastVerifiedAt: Schema.optional(Schema.String),
  fallbackHitRate: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.Number }),
    {
      default: () => ({}),
    }
  ),
}) {}

// ── The artifact ─────────────────────────────────────────────────────────

export class CapabilityArtifact extends Schema.Class<CapabilityArtifact>(
  "CapabilityArtifact"
)({
  schemaVersion: Schema.Literal("capability/v1"),
  id: Schema.String,
  /** The name an agent calls it by. Stable across versions. */
  name: Schema.String,
  /** Semver. Steps changing is a patch; the input/output contract changing is major. */
  version: Schema.String,
  status: CapabilityStatus,
  /** Written for the calling agent: this is what it reads to decide to invoke. */
  description: Schema.String,

  target: TargetBinding,

  inputs: Schema.Array(InputParam),
  outputs: Schema.Array(OutputField),
  outcomes: Schema.Array(DeclaredOutcome),

  steps: Schema.Array(Step),
  recoveries: Schema.optionalWith(Schema.Array(Recovery), {
    default: () => [],
  }),
  /** Asserted at the end. The difference between "ran" and "worked". */
  successCondition: Condition,

  policy: PolicyBinding,
  provenance: Provenance,
  health: Schema.optional(Health),
}) {}

export const decodeCapability = Schema.decodeUnknown(CapabilityArtifact)
export const encodeCapability = Schema.encode(CapabilityArtifact)

/** Parse an artifact straight from its on-disk JSON. */
export const decodeCapabilityJson = Schema.decodeUnknown(
  Schema.parseJson(CapabilityArtifact)
)
