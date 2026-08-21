import { Schema } from "effect"

import { Resolution } from "./targeting.js"

/**
 * What a replay tells its caller.
 *
 * The brief names conflating a business outcome with a failure as the most
 * common design mistake in this problem, so the split is structural here rather
 * than conventional. Three things can be true after a replay, and they are
 * different *types*, not different values of an `error` string:
 *
 *   Succeeded        the flow completed and produced its declared outputs
 *   BusinessOutcome  the application answered, and the answer was a declared
 *                    non-success — "no such member", "permission denied".
 *                    The caller needs this. It is not an incident.
 *   Failed           the system could not determine an answer
 *
 * Escalated is a fourth, and sits deliberately outside the success/failure axis:
 * it means a human was brought in, and the run's fate depends on what they did.
 *
 * Recoverable conditions — an interstitial, a stale element, an expired session —
 * appear in none of these. They are handled inside the executor and recorded in
 * the trace. A caller should never have to know that step three needed two
 * retries, only that it worked.
 */

// ── Failure taxonomy ─────────────────────────────────────────────────────

/**
 * Every variant carries what is needed to debug without re-running: which step,
 * what was expected, what was actually observed.
 */
export const ReplayError = Schema.Union(
  /** Caught before touching the surface, so nothing was acted on. */
  Schema.TaggedStruct("InputValidationFailed", {
    issues: Schema.Array(Schema.String),
  }),
  /** Every ranked strategy was tried and none matched. */
  Schema.TaggedStruct("TargetNotFound", {
    stepId: Schema.String,
    targetDescription: Schema.String,
    strategiesTried: Schema.Number,
  }),
  /**
   * A strategy matched more than one control. Deliberately fatal rather than
   * "take the first": acting on the wrong control in a banking app is worse
   * than not acting.
   */
  Schema.TaggedStruct("AmbiguousTarget", {
    stepId: Schema.String,
    targetDescription: Schema.String,
    matchCount: Schema.Number,
  }),
  /** The action ran but the world did not end up where the artifact expected. */
  Schema.TaggedStruct("CheckpointFailed", {
    stepId: Schema.String,
    expected: Schema.String,
    observed: Schema.String,
  }),
  Schema.TaggedStruct("StepTimeout", {
    stepId: Schema.String,
    waitedMs: Schema.Number,
  }),
  /** The guardrail refused. Not a bug — the system working. */
  Schema.TaggedStruct("PolicyDenied", {
    stepId: Schema.String,
    rule: Schema.String,
    reason: Schema.String,
  }),
  /** Session expiry that re-authentication did not fix. */
  Schema.TaggedStruct("SessionExpiredUnrecoverable", {
    stepId: Schema.String,
    reauthAttempts: Schema.Number,
  }),
  /** A dialog appeared that no declared recovery knows how to answer. */
  Schema.TaggedStruct("UnexpectedDialog", {
    stepId: Schema.String,
    dialogText: Schema.String,
  }),
  /** The application itself broke. */
  Schema.TaggedStruct("ApplicationError", {
    stepId: Schema.String,
    detail: Schema.String,
  }),
  /** The browser or adapter died. */
  Schema.TaggedStruct("SurfaceUnavailable", {
    stepId: Schema.optional(Schema.String),
    detail: Schema.String,
  })
)
export type ReplayError = typeof ReplayError.Type

// ── Trace ────────────────────────────────────────────────────────────────

/**
 * One entry per thing that happened, including the things that worked. The
 * resolution is recorded even on success — that is where drift shows up.
 */
export const TraceEvent = Schema.Union(
  Schema.TaggedStruct("StepStarted", {
    stepId: Schema.String,
    intent: Schema.String,
    at: Schema.String,
  }),
  Schema.TaggedStruct("TargetResolved", {
    stepId: Schema.String,
    resolution: Resolution,
  }),
  Schema.TaggedStruct("ActionPerformed", {
    stepId: Schema.String,
    action: Schema.String,
    durationMs: Schema.Number,
  }),
  Schema.TaggedStruct("CheckpointPassed", { stepId: Schema.String }),
  /** A handled runtime condition. Invisible to the caller, visible to an operator. */
  Schema.TaggedStruct("RecoveryApplied", {
    stepId: Schema.String,
    recovery: Schema.String,
    attempt: Schema.Number,
  }),
  Schema.TaggedStruct("PolicyDecision", {
    stepId: Schema.String,
    decision: Schema.String,
    rule: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("OutcomeDetected", {
    stepId: Schema.String,
    outcome: Schema.String,
  }),
  Schema.TaggedStruct("EvidenceCaptured", {
    stepId: Schema.optional(Schema.String),
    kind: Schema.String,
    ref: Schema.String,
  })
)
export type TraceEvent = typeof TraceEvent.Type

// ── Result ───────────────────────────────────────────────────────────────

export const ReplayOutputs = Schema.Record({
  key: Schema.String,
  value: Schema.Union(
    Schema.String,
    Schema.Number,
    Schema.Boolean,
    Schema.Null
  ),
})
export type ReplayOutputs = typeof ReplayOutputs.Type

export const ReplaySummary = Schema.Struct({
  runId: Schema.String,
  capabilityId: Schema.String,
  capabilityVersion: Schema.String,
  tenant: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  durationMs: Schema.Number,
  stepsAttempted: Schema.Number,
  /** Where the evidence for this run lives. */
  evidenceRef: Schema.optional(Schema.String),
})
export type ReplaySummary = typeof ReplaySummary.Type

export const ReplayResult = Schema.Union(
  Schema.TaggedStruct("Succeeded", {
    summary: ReplaySummary,
    outputs: ReplayOutputs,
    trace: Schema.Array(TraceEvent),
  }),
  Schema.TaggedStruct("BusinessOutcome", {
    summary: ReplaySummary,
    /** The declared outcome tag, e.g. `MemberNotFound`. */
    outcome: Schema.String,
    detail: Schema.String,
    atStepId: Schema.String,
    outputs: ReplayOutputs,
    trace: Schema.Array(TraceEvent),
  }),
  Schema.TaggedStruct("Escalated", {
    summary: ReplaySummary,
    interventionId: Schema.String,
    reason: Schema.String,
    atStepId: Schema.String,
    trace: Schema.Array(TraceEvent),
  }),
  Schema.TaggedStruct("Failed", {
    summary: ReplaySummary,
    error: ReplayError,
    trace: Schema.Array(TraceEvent),
  })
)
export type ReplayResult = typeof ReplayResult.Type

/**
 * True when the capability produced a usable answer of any kind. A business
 * outcome is an answer — a caller that treats it as a failure will retry
 * something that will never succeed.
 */
export const isAnswered = (result: ReplayResult): boolean =>
  result._tag === "Succeeded" || result._tag === "BusinessOutcome"
