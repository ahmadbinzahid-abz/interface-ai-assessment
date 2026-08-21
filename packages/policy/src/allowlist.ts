import { Schema } from "effect"

/**
 * What the automation is permitted to do, as data.
 *
 * The allowlist is configuration rather than code so that an institution's
 * security team can review and change it without a deploy, and so a capability
 * can name the policy it runs under (`policy.allowlistRef`) instead of carrying
 * its own permissions around.
 *
 * Everything is default-deny. An origin that is not listed is refused, an action
 * kind that is not listed is refused. That matters more than it sounds: a
 * prompt-injected model that talks the agent into navigating somewhere else
 * still cannot, because the refusal is downstream of anything the model says.
 */

export const ActionKind = Schema.Literal(
  "navigate",
  "click",
  "type",
  "select",
  "press",
  "extract",
  "waitFor",
  "reauth"
)
export type ActionKind = typeof ActionKind.Type

export class AllowlistConfig extends Schema.Class<AllowlistConfig>(
  "AllowlistConfig"
)({
  id: Schema.String,
  description: Schema.String,

  /** Exact origins, e.g. `http://localhost:4100`. No wildcards, on purpose. */
  allowedOrigins: Schema.Array(Schema.String),

  /** Regular expressions matched against the path. Empty means every path. */
  allowedPaths: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),

  /**
   * Checked before `allowedPaths`, so a broad allow can still carve out an
   * exception — the stand-in's `/__control` test hooks, for instance, which the
   * automation must never touch.
   */
  deniedPaths: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),

  allowedActions: Schema.Array(ActionKind),

  /**
   * Control labels that change state but can be undone. Matched
   * case-insensitively against the visible label of whatever is being clicked.
   */
  riskyControlPatterns: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),

  /**
   * Control labels with no undo. In this domain that means money movement and
   * account lifecycle, and it is the class that must never be executed by a
   * model without a person in the loop.
   */
  irreversibleControlPatterns: Schema.optionalWith(
    Schema.Array(Schema.String),
    {
      default: () => [],
    }
  ),
}) {}

export const decodeAllowlist = Schema.decodeUnknown(AllowlistConfig)

/**
 * The policy the discovery run and the demo capabilities use.
 *
 * Deliberately conservative: read-only navigation across the servicing desk,
 * with anything that closes an account or moves money classed irreversible so
 * the guardrail has something real to refuse.
 */
export const coreBankReadonly = new AllowlistConfig({
  id: "corebank-readonly",
  description: "Read-only servicing operations against the CoreBank stand-in.",
  allowedOrigins: ["http://localhost:4100", "http://127.0.0.1:4100"],
  allowedPaths: ["^/(firstcity|riverbend)(/|$)"],
  // The fault-injection hooks are test scaffolding, not application surface.
  deniedPaths: ["^/__control"],
  allowedActions: [
    "navigate",
    "click",
    "type",
    "select",
    "press",
    "extract",
    "waitFor",
    "reauth",
  ],
  riskyControlPatterns: [
    "\\bsubmit\\b",
    "\\bcontinue\\b",
    "\\bconfirm\\b",
    "\\bsave\\b",
    "\\bpost\\b",
  ],
  irreversibleControlPatterns: [
    "\\bclose\\s+account\\b",
    "\\bdelete\\b",
    "\\bwire\\b",
    "\\btransfer\\b",
    "\\bdisburse\\b",
    "\\bwithdraw\\b",
  ],
})
