import { Schema } from "effect"

/**
 * How a control is identified.
 *
 * The central decision in this system: a recorded target is **not a selector**.
 * It is a ranked list of strategies, tried in order, each of which must match
 * exactly one control. A selector encodes the page's implementation; a role plus
 * an accessible name plus a relation to a nearby label encodes what a human
 * operator actually looks for, which is the thing that stays true when the
 * markup does not.
 *
 * Ranking matters twice. It makes replay resilient, and it makes drift
 * *observable*: replay records which rank won, so a step that quietly stops
 * resolving by role and starts resolving by its CSS fallback is a signal that
 * this tenant's UI has moved, long before the step fails outright.
 */

/**
 * Deliberately a closed set, and deliberately small: these are roles that exist
 * on the web AX tree, on Windows UI Automation, and on the macOS AX API. Keeping
 * the vocabulary to their intersection is what lets the same descriptor describe
 * a control on a desktop surface later.
 */
export const ControlRole = Schema.Literal(
  "button",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "link",
  "cell",
  "row",
  "table",
  "heading",
  "list",
  "listitem",
  "menuitem",
  "tab",
  "dialog",
  "alert",
  "image",
  "text"
)
export type ControlRole = typeof ControlRole.Type

/**
 * Where the control lives. A frameset nests documents, and a control in
 * `contentFrame` is a different control from one of the same name in `navFrame`.
 * Empty means the top document.
 */
export const FramePath = Schema.Array(Schema.String)
export type FramePath = typeof FramePath.Type

export const TextMatch = Schema.Struct({
  text: Schema.String,
  /** Exact by default: substring matching is how you silently target the wrong cell. */
  exact: Schema.optionalWith(Schema.Boolean, { default: () => true }),
})
export type TextMatch = typeof TextMatch.Type

/**
 * How the target sits relative to a landmark that *can* be named.
 *
 * This is the strategy that makes legacy table layouts tractable. A field with no
 * label association, no id and no placeholder has no accessible name at all — but
 * the cell to its left reads "Member Number", and that is exactly how a person
 * finds it.
 */
export const AnchorRelation = Schema.Literal(
  "rightOf",
  "leftOf",
  "below",
  "above",
  /** The target is a descendant of the anchor — e.g. a cell inside a matched row. */
  "within"
)
export type AnchorRelation = typeof AnchorRelation.Type

export const Anchor = Schema.Struct({
  relation: AnchorRelation,
  /** Role of the landmark itself, usually `cell` in these applications. */
  role: Schema.optional(ControlRole),
  match: TextMatch,
})
export type Anchor = typeof Anchor.Type

/**
 * Last-resort strategies, in the order a reviewer should expect them to degrade.
 *
 * `controlName` is listed as a fallback rather than a primary on purpose. The
 * `name` attribute of a legacy control (`f1_ctl03`) is meaningless to a human but
 * empirically stable across tenants running the same vendor build — so it is a
 * good safety net and a bad primary, because when the vendor renumbers its
 * controls it changes silently and points at the wrong field rather than at none.
 */
export const FallbackStrategy = Schema.Union(
  Schema.TaggedStruct("controlName", { name: Schema.String }),
  Schema.TaggedStruct("css", { selector: Schema.String }),
  Schema.TaggedStruct("xpath", { expression: Schema.String }),
  /**
   * Absolute viewport coordinates. Only ever recorded when nothing else resolved,
   * and always the lowest rank: it survives no layout change at all, but it is
   * the one thing that still works on a surface with no queryable structure.
   */
  Schema.TaggedStruct("point", {
    x: Schema.Number,
    y: Schema.Number,
    viewport: Schema.Struct({ width: Schema.Number, height: Schema.Number }),
  })
)
export type FallbackStrategy = typeof FallbackStrategy.Type

export class TargetDescriptor extends Schema.Class<TargetDescriptor>(
  "TargetDescriptor"
)({
  /** Plain English, so a human reviewing the artifact knows what is being clicked. */
  description: Schema.String,
  frame: Schema.optionalWith(FramePath, { default: () => [] }),
  /** Role, plus an accessible name when the control has one. Rank 0. */
  role: Schema.optional(ControlRole),
  name: Schema.optional(TextMatch),
  /** Tried in order after role+name. */
  anchors: Schema.optionalWith(Schema.Array(Anchor), { default: () => [] }),
  /**
   * Resolution requires exactly one match. When a page legitimately contains
   * several identical controls, the ambiguity has to be *declared* here rather
   * than silently resolved by taking the first — an artifact that says `nth: 0`
   * is reviewable, one that guesses is not.
   */
  nth: Schema.optional(Schema.Number),
  fallbacks: Schema.optionalWith(Schema.Array(FallbackStrategy), {
    default: () => [],
  }),
}) {}

/** Which strategy actually resolved a target, recorded on every replayed step. */
export const ResolutionStrategy = Schema.Union(
  Schema.TaggedStruct("roleAndName", {}),
  Schema.TaggedStruct("anchor", { index: Schema.Number }),
  Schema.TaggedStruct("fallback", { index: Schema.Number, kind: Schema.String })
)
export type ResolutionStrategy = typeof ResolutionStrategy.Type

/**
 * `rank` is the position in the whole ordered strategy list, so it is comparable
 * across steps and across tenants. Rank 0 is the primary; anything above it is
 * degradation worth watching.
 */
export const Resolution = Schema.Struct({
  strategy: ResolutionStrategy,
  rank: Schema.Number,
  matchCount: Schema.Number,
})
export type Resolution = typeof Resolution.Type
