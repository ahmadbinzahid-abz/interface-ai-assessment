import { Schema } from "effect"

import { TargetDescriptor } from "./targeting.js"
import { ValueRef } from "./values.js"

/**
 * A predicate over an observation.
 *
 * One vocabulary serves four jobs, which is why it is worth defining carefully:
 * step **checkpoints** ("did the click actually work?"), declared **business
 * outcomes** ("is this the no-such-member page?"), **recovery** triggers ("is
 * this the maintenance interstitial?"), and **success** conditions.
 *
 * Making all four the same type is what allows one evaluator to run them in a
 * fixed priority order after every step, rather than scattering ad-hoc checks
 * through the executor.
 */

const leaves = [
  Schema.TaggedStruct("urlMatches", { pattern: Schema.String }),
  Schema.TaggedStruct("textPresent", {
    text: Schema.String,
    /** Scope the search, so "error" in a footer does not trip a checkpoint. */
    within: Schema.optional(TargetDescriptor),
  }),
  Schema.TaggedStruct("textAbsent", { text: Schema.String }),
  Schema.TaggedStruct("elementPresent", { target: TargetDescriptor }),
  Schema.TaggedStruct("elementAbsent", { target: TargetDescriptor }),
  /** Confirms a field really holds what we typed, rather than assuming it. */
  Schema.TaggedStruct("valueEquals", {
    target: TargetDescriptor,
    expected: ValueRef,
  }),
  /**
   * Status is a weak signal in these applications — the stand-in returns 200 for
   * an expired session — so it is available but never the only assertion.
   */
  Schema.TaggedStruct("httpStatusIn", {
    statuses: Schema.Array(Schema.Number),
  }),
] as const

export const LeafCondition = Schema.Union(...leaves)
export type LeafCondition = typeof LeafCondition.Type

/**
 * Composition is one level deep, not arbitrarily recursive.
 *
 * A recursive schema is possible but costs an explicit type annotation and worse
 * inference everywhere it is used, and in this domain every real checkpoint is
 * either a leaf or a conjunction of leaves. If a condition ever genuinely needs
 * nesting, that is a sign the step should be split.
 */
export const Condition = Schema.Union(
  ...leaves,
  Schema.TaggedStruct("all", { of: Schema.Array(LeafCondition) }),
  Schema.TaggedStruct("any", { of: Schema.Array(LeafCondition) }),
  Schema.TaggedStruct("not", { condition: LeafCondition })
)
export type Condition = typeof Condition.Type

export const urlMatches = (pattern: string): Condition => ({
  _tag: "urlMatches",
  pattern,
})

export const textPresent = (text: string): Condition => ({
  _tag: "textPresent",
  text,
})

export const allOf = (...of: readonly LeafCondition[]): Condition => ({
  _tag: "all",
  of,
})
