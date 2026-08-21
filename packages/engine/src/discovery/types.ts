import {
  Action,
  Condition,
  RiskClass,
  Sensitivity,
  ValueFormat,
} from "@workspace/contracts"
import { Schema } from "effect"

/**
 * What a discovery run produced.
 *
 * Defined as schemas rather than plain interfaces because the run is *persisted*
 * — `evidence/…/run.json` — and later read back by `cua recompile` to re-emit an
 * artifact through an improved compiler without paying for another model run.
 * A persisted shape that is only an interface is an unchecked cast waiting to
 * happen, and here it would silently produce a half-valid capability: the steps
 * carry `TargetDescriptor`s, which are classes with their own validation, and
 * plain JSON objects do not satisfy them.
 */

export const DiscoveryParameter = Schema.Struct({
  name: Schema.String,
  /** The concrete value used during discovery. Never persisted into the artifact. */
  value: Schema.String,
  description: Schema.String,
  sensitivity: Schema.optional(Sensitivity),
})
export type DiscoveryParameter = typeof DiscoveryParameter.Type

/**
 * A step as it was actually performed, before compilation.
 *
 * Kept separate from the artifact's `Step` because discovery knows things the
 * artifact should not carry — how long it took, which strategy rank resolved it,
 * whether it was exploratory — and because the compiler still has work to do
 * afterwards.
 */
export const RecordedStep = Schema.Struct({
  id: Schema.String,
  intent: Schema.String,
  action: Action,
  riskClass: RiskClass,
  checkpoint: Schema.optional(Condition),
  observedMs: Schema.Number,
  /** Which ranked strategy found the target when it was recorded. */
  resolvedAtRank: Schema.optional(Schema.Number),
  /**
   * The model took this step to *learn* the application rather than to advance
   * the goal — probing an invalid id to find the not-found screen. Kept in
   * evidence, excluded from the compiled flow.
   */
  exploratory: Schema.optional(Schema.Boolean),
})
export type RecordedStep = typeof RecordedStep.Type

export const RecordedOutput = Schema.Struct({
  name: Schema.String,
  format: ValueFormat,
  description: Schema.String,
  /** What was actually read during discovery, for evidence only. */
  sampleValue: Schema.String,
})
export type RecordedOutput = typeof RecordedOutput.Type

export const RecordedOutcome = Schema.Struct({
  tag: Schema.String,
  description: Schema.String,
  whenText: Schema.String,
})
export type RecordedOutcome = typeof RecordedOutcome.Type

export const DiscoveryResult = Schema.Union(
  Schema.TaggedStruct("Completed", {
    summary: Schema.String,
    successText: Schema.String,
  }),
  /** The model asked for a human. A legitimate ending, not a failure. */
  Schema.TaggedStruct("Escalated", { reason: Schema.String }),
  Schema.TaggedStruct("GaveUp", { reason: Schema.String }),
  /** A stopping condition fired: too many turns, too long, or no progress. */
  Schema.TaggedStruct("Exhausted", { reason: Schema.String })
)
export type DiscoveryResult = typeof DiscoveryResult.Type

export const DiscoveryRun = Schema.Struct({
  runId: Schema.String,
  result: DiscoveryResult,
  steps: Schema.Array(RecordedStep),
  outputs: Schema.Array(RecordedOutput),
  outcomes: Schema.Array(RecordedOutcome),
  modelId: Schema.String,
  turns: Schema.Number,
  durationMs: Schema.Number,
})
export type DiscoveryRun = typeof DiscoveryRun.Type

/** Read a persisted run back, with every nested class properly reconstructed. */
export const decodeDiscoveryRun = Schema.decodeUnknown(DiscoveryRun)
