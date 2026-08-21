import { Schema } from "effect"

/**
 * How sensitive a value is. This drives redaction everywhere: a field marked
 * anything other than `none` is masked by value in logs, screenshots, and
 * evidence, and a `secret` never reaches an artifact at all.
 */
export const Sensitivity = Schema.Literal(
  "none",
  /** Not secret on its own, but identifies a person when joined. */
  "identifier",
  "pii",
  "financial",
  "secret"
)
export type Sensitivity = typeof Sensitivity.Type

export const ValueType = Schema.Literal("string", "number", "boolean")
export type ValueType = typeof ValueType.Type

/** How an extracted string is decoded into a typed output. */
export const ValueFormat = Schema.Literal(
  "text",
  "integer",
  "decimal",
  "currency-usd",
  "date-iso",
  "boolean"
)
export type ValueFormat = typeof ValueFormat.Type

/**
 * A value a step supplies to the surface.
 *
 * Recorded steps never inline a concrete value. The discovery compiler rewrites
 * anything that came from the goal into a `param`, and anything that came from a
 * credential store into a `secret`. That is what makes an artifact both reusable
 * (the member id is an argument, not a constant) and safe to commit (regulated
 * data and credentials are references, never contents).
 */
export const ValueRef = Schema.Union(
  /** A constant that is genuinely part of the flow, e.g. a product name. */
  Schema.TaggedStruct("literal", { value: Schema.String }),
  /** Supplied by the caller at invocation time. */
  Schema.TaggedStruct("param", { name: Schema.String }),
  /** Resolved from the vault at replay time. Never persisted. */
  Schema.TaggedStruct("secret", { ref: Schema.String }),
  /** A value extracted by an earlier step in the same run. */
  Schema.TaggedStruct("output", { name: Schema.String })
)
export type ValueRef = typeof ValueRef.Type

export const literal = (value: string): ValueRef => ({ _tag: "literal", value })
export const param = (name: string): ValueRef => ({ _tag: "param", name })
export const secret = (ref: string): ValueRef => ({ _tag: "secret", ref })

/** True for any reference whose resolved contents must never be persisted. */
export const isSecretRef = (ref: ValueRef): boolean => ref._tag === "secret"
