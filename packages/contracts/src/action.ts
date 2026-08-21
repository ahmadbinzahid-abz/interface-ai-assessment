import { Schema } from "effect"

import { Condition } from "./condition.js"
import { TargetDescriptor } from "./targeting.js"
import { ValueFormat, ValueRef } from "./values.js"

/**
 * What the system can do to a surface.
 *
 * The set is small and surface-agnostic on purpose. Every one of these has a
 * direct equivalent on a browser, on a Windows UI Automation tree, and on a
 * screenshot-and-coordinates surface. Nothing here mentions the DOM, a selector,
 * or a browser — that is the seam that lets a recorded flow outlive the adapter
 * it was recorded through.
 *
 * `reauth` is the odd one out: it is not something a human does to a control, it
 * is a recovery primitive the engine implements. It lives here so that a
 * recovery is expressed in the same vocabulary as a step.
 */
export const Action = Schema.Union(
  Schema.TaggedStruct("navigate", { url: ValueRef }),
  Schema.TaggedStruct("click", { target: TargetDescriptor }),
  Schema.TaggedStruct("type", {
    target: TargetDescriptor,
    value: ValueRef,
    clearFirst: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  }),
  Schema.TaggedStruct("select", { target: TargetDescriptor, value: ValueRef }),
  Schema.TaggedStruct("press", { key: Schema.String }),
  /** Reads a value out of the page and binds it to a declared output. */
  Schema.TaggedStruct("extract", {
    target: TargetDescriptor,
    output: Schema.String,
    as: ValueFormat,
  }),
  /** An explicit wait on a condition. Never a sleep. */
  Schema.TaggedStruct("waitFor", {
    condition: Condition,
    timeoutMs: Schema.optionalWith(Schema.Number, { default: () => 10_000 }),
  }),
  /** Re-establish a session using the capability's declared credentials. */
  Schema.TaggedStruct("reauth", {})
)
export type Action = typeof Action.Type

/**
 * How dangerous an action is, independent of what it does.
 *
 * The ladder exists so policy can act per action rather than per capability:
 *
 *  - `safe`         reading, navigating, filling a field — reversible, no effect
 *  - `risky`        submitting something that changes state but can be undone
 *  - `irreversible` moving money, closing an account — no undo
 *
 * Discovery is capped at `safe`, so the model may *reach* a confirmation screen
 * but is blocked from pressing the button and must escalate. An unsupervised
 * model should never be the last actor before an irreversible financial action.
 */
export const RiskClass = Schema.Literal("safe", "risky", "irreversible")
export type RiskClass = typeof RiskClass.Type

/** Actions that only read are safe regardless of what the artifact claims. */
export const isReadOnlyAction = (action: Action): boolean =>
  action._tag === "extract" || action._tag === "waitFor"
