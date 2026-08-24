import { Schema } from "effect"

/**
 * Handing a running automation to a person, and taking it back.
 *
 * The brief calls this out separately from error handling, and it is a different
 * problem: a failure is something the run reports and stops on, whereas an
 * intervention is something the run *waits* on. The distinction shows up in the
 * types — a `Failed` replay is over, an escalated one is suspended and may still
 * succeed once a human has done the part it could not.
 *
 * Everything here is the vocabulary shared by the engine that raises an
 * intervention, the gateway that serves it, and the console an operator answers
 * it in. None of it knows about browsers or WebSockets.
 */

// ── Control state ────────────────────────────────────────────────────────

/**
 * Who is driving, as a state machine rather than a boolean.
 *
 * The intermediate states are the point. `PauseRequested` exists because an
 * automation cannot stop mid-action — a click that has been dispatched has to be
 * allowed to land, or the operator inherits a half-submitted form. `AwaitingOperator`
 * exists because nobody may be looking at the queue yet, and the run has to hold
 * that state durably rather than time out into a failure. `HandbackRequested`
 * exists because control returns on the operator's word, not on a disconnect.
 */
export const ControlState = Schema.Union(
  /** Nobody has claimed the session — it is idle between runs. */
  Schema.TaggedStruct("Idle", {}),
  Schema.TaggedStruct("AutomationDriving", { runId: Schema.String }),
  /** Stop asked for; the action in flight is being allowed to complete. */
  Schema.TaggedStruct("PauseRequested", {
    runId: Schema.String,
    interventionId: Schema.String,
  }),
  /** Paused and safe. Waiting for a person to pick it up. */
  Schema.TaggedStruct("AwaitingOperator", {
    runId: Schema.String,
    interventionId: Schema.String,
  }),
  Schema.TaggedStruct("OperatorDriving", {
    runId: Schema.String,
    interventionId: Schema.String,
    operatorId: Schema.String,
  }),
  /** The operator has said they are done; the run has not resumed yet. */
  Schema.TaggedStruct("HandbackRequested", {
    runId: Schema.String,
    interventionId: Schema.String,
    operatorId: Schema.String,
    disposition: Schema.Literal("retryStep", "skipStep", "abort"),
  })
)
export type ControlState = typeof ControlState.Type

/** Who currently may act, derived from the state. Nothing else decides this. */
export const controlHolderOf = (
  state: ControlState
): { readonly kind: "automation" | "operator" | "none"; readonly id?: string } => {
  switch (state._tag) {
    case "AutomationDriving":
      return { kind: "automation", id: state.runId }
    case "PauseRequested":
      // The in-flight action still belongs to the automation. This is exactly
      // the window that makes pausing safe rather than abrupt.
      return { kind: "automation", id: state.runId }
    case "OperatorDriving":
    case "HandbackRequested":
      return { kind: "operator", id: state.operatorId }
    default:
      return { kind: "none" }
  }
}

/**
 * The state in words, for anything that shows it to a person.
 *
 * Here rather than in the engine because the console needs it and the console
 * must not depend on the engine — that package carries Playwright and a model
 * client, neither of which belongs in a browser bundle. A pure function over a
 * contract type belongs with the contract.
 */
export const describeControlState = (state: ControlState): string => {
  switch (state._tag) {
    case "Idle":
      return "idle"
    case "AutomationDriving":
      return `automation ${state.runId} is driving`
    case "PauseRequested":
      return "pausing — finishing the action in flight"
    case "AwaitingOperator":
      return "paused, waiting for an operator"
    case "OperatorDriving":
      return `${state.operatorId} is driving`
    case "HandbackRequested":
      return `${state.operatorId} handed back (${state.disposition})`
  }
}

// ── Why a run stopped ────────────────────────────────────────────────────

/**
 * The stuck triggers from the design, as data.
 *
 * Naming them separately from the human-readable reason matters for the console:
 * an inbox that can group "policy wants approval" apart from "the UI moved" is
 * the difference between an operator queue and a log file.
 */
export const EscalationTrigger = Schema.Literal(
  /** Policy classified the step as needing a person. The designed path. */
  "policyRequiresApproval",
  /** Every ranked strategy was tried and nothing matched — the UI moved. */
  "targetNotFound",
  /** More than one control matched, and guessing is not allowed. */
  "ambiguousTarget",
  /** Repeated actions with no state change: the loop detector. */
  "noProgress",
  /** A dialog appeared that no declared recovery answers. */
  "undeclaredDialog",
  /** Re-authentication did not restore the session. */
  "sessionUnrecoverable",
  /** Step or wall-clock budget exhausted. */
  "budgetExhausted"
)
export type EscalationTrigger = typeof EscalationTrigger.Type

// ── What the operator did ────────────────────────────────────────────────

/**
 * One thing a human did while holding the session.
 *
 * Captured at two levels on purpose. The coordinate is what actually happened
 * and is what makes the log faithful; `targetRole`/`targetName` are the
 * accessibility tree read back at that point, and are what make the log
 * *promotable* — a recorded click at (412, 388) can never become an artifact
 * step, but "clicked the button named Confirm" can.
 *
 * `text` is redacted at the evidence boundary like everything else, so a
 * password typed by an operator during takeover is masked by the same mechanism
 * that masks one typed by the automation.
 */
export class OperatorAction extends Schema.Class<OperatorAction>(
  "OperatorAction"
)({
  at: Schema.String,
  kind: Schema.Literal("click", "type", "key", "scroll", "navigate"),
  targetRole: Schema.optional(Schema.String),
  targetName: Schema.optional(Schema.String),
  /** Frame path, so a capture inside a frameset is unambiguous. */
  frame: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  text: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  point: Schema.optional(
    Schema.Struct({ x: Schema.Number, y: Schema.Number })
  ),
}) {}

// ── The intervention ─────────────────────────────────────────────────────

/**
 * Everything a person needs to act without asking anybody what happened.
 *
 * The list is taken from §5 of the design and is deliberately complete: the goal,
 * the step and its intent, why it stopped, a screenshot, and the recent action
 * log. An intervention that says only "step 7 failed" makes the operator
 * re-derive the context the engine already had.
 */
export class Intervention extends Schema.Class<Intervention>("Intervention")({
  id: Schema.String,
  sessionId: Schema.String,
  runId: Schema.String,
  capability: Schema.String,
  capabilityVersion: Schema.String,
  tenant: Schema.NullOr(Schema.String),
  /** What the capability as a whole is for. */
  goal: Schema.String,
  stepId: Schema.String,
  /** The step's own English intent — what the automation was about to do. */
  stepIntent: Schema.String,
  trigger: EscalationTrigger,
  reason: Schema.String,
  raisedAt: Schema.String,
  /** Redacted before it was written. */
  screenshotRef: Schema.optional(Schema.String),
  /** What the automation did just before it stopped. */
  recentActions: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),
  status: Schema.Literal("awaiting", "claimed", "resolved"),
  claimedBy: Schema.optional(Schema.String),
  resolution: Schema.optional(
    Schema.Union(
      /**
       * The operator did the part the automation could not. `disposition` says
       * what to do with the step that stopped: `skipStep` when the human
       * performed it themselves, `retryStep` when they cleared an obstruction
       * and the automation should try again.
       */
      Schema.TaggedStruct("Resumed", {
        by: Schema.String,
        at: Schema.String,
        disposition: Schema.Literal("retryStep", "skipStep"),
        operatorActions: Schema.Array(OperatorAction),
        note: Schema.optional(Schema.String),
      }),
      Schema.TaggedStruct("Aborted", {
        by: Schema.String,
        at: Schema.String,
        note: Schema.optional(Schema.String),
      })
    )
  ),
}) {}

export const decodeIntervention = Schema.decodeUnknown(Intervention)
export const encodeIntervention = Schema.encode(Intervention)
