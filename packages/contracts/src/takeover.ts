import { Schema } from "effect"

import { ControlState, Intervention, OperatorAction } from "./intervention.js"

/**
 * The wire protocol for live takeover.
 *
 * Co-browsing is the part of this system that has to be *real* rather than
 * described, so the protocol is declared here in the contracts package and both
 * ends are derived from it: the gateway decodes what it receives and the console
 * is type-checked against what it may send. A screencast that silently accepts a
 * malformed input event would be the easiest place in the system to introduce an
 * unauditable action.
 *
 * Two properties are deliberate:
 *
 *  1. **Input is coordinate-level, not action-level.** The operator is driving a
 *     browser, not filling in a form the system understands. Anything narrower
 *     would fail exactly when it is needed — on the screen the automation could
 *     not handle.
 *  2. **Every inbound message is attributed.** The operator id travels with the
 *     claim, and the surface refuses input from anyone who does not hold the
 *     lease, so an open socket is not by itself permission to act.
 */

// ── Input ────────────────────────────────────────────────────────────────

export const MouseButton = Schema.Literal("left", "middle", "right", "none")
export type MouseButton = typeof MouseButton.Type

/**
 * Raw input, in the screencast frame's own coordinate space.
 *
 * The gateway does not scale these — the console reports the frame's natural
 * size along with each frame and sends coordinates against it, so the mapping
 * lives in one place rather than in both.
 */
export const OperatorInput = Schema.Union(
  Schema.TaggedStruct("mouseMoved", {
    x: Schema.Number,
    y: Schema.Number,
  }),
  Schema.TaggedStruct("mousePressed", {
    x: Schema.Number,
    y: Schema.Number,
    button: MouseButton,
    clickCount: Schema.optionalWith(Schema.Number, { default: () => 1 }),
  }),
  Schema.TaggedStruct("mouseReleased", {
    x: Schema.Number,
    y: Schema.Number,
    button: MouseButton,
    clickCount: Schema.optionalWith(Schema.Number, { default: () => 1 }),
  }),
  Schema.TaggedStruct("mouseWheel", {
    x: Schema.Number,
    y: Schema.Number,
    deltaX: Schema.Number,
    deltaY: Schema.Number,
  }),
  Schema.TaggedStruct("keyDown", {
    key: Schema.String,
    code: Schema.optional(Schema.String),
    /** Printable text this key produces, when it produces any. */
    text: Schema.optional(Schema.String),
    modifiers: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  }),
  Schema.TaggedStruct("keyUp", {
    key: Schema.String,
    code: Schema.optional(Schema.String),
    modifiers: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  }),
  /** Typing a whole string at once, which is what a paste or an IME produces. */
  Schema.TaggedStruct("insertText", { text: Schema.String })
)
export type OperatorInput = typeof OperatorInput.Type

// ── Console → gateway ────────────────────────────────────────────────────

export const TakeoverClientMessage = Schema.Union(
  /**
   * Ask for the session. Refused unless the intervention is awaiting an
   * operator — a second console watching the same run gets frames but no lease.
   */
  Schema.TaggedStruct("claim", {
    interventionId: Schema.String,
    operatorId: Schema.String,
  }),
  Schema.TaggedStruct("input", { event: OperatorInput }),
  /** Navigate the live page. Goes through policy like any other action. */
  Schema.TaggedStruct("navigate", { url: Schema.String }),
  /** Done. `disposition` tells the run what to do with the step that stopped. */
  Schema.TaggedStruct("handback", {
    disposition: Schema.Literal("retryStep", "skipStep"),
    note: Schema.optional(Schema.String),
  }),
  /** Give up on the run entirely. */
  Schema.TaggedStruct("abort", { note: Schema.optional(Schema.String) }),
  /** Keeps the screencast alive through an idle proxy. */
  Schema.TaggedStruct("ping", {})
)
export type TakeoverClientMessage = typeof TakeoverClientMessage.Type

export const decodeTakeoverClientMessage = Schema.decodeUnknown(
  TakeoverClientMessage
)

// ── Gateway → console ────────────────────────────────────────────────────

export const TakeoverServerMessage = Schema.Union(
  /** Sent once on connect: what this session is and why it stopped. */
  Schema.TaggedStruct("hello", {
    sessionId: Schema.String,
    state: ControlState,
    intervention: Schema.NullOr(Intervention),
  }),
  /** One screencast frame, base64 JPEG, with the size its coordinates are in. */
  Schema.TaggedStruct("frame", {
    data: Schema.String,
    width: Schema.Number,
    height: Schema.Number,
    at: Schema.String,
  }),
  Schema.TaggedStruct("state", { state: ControlState }),
  /** Echoed back as the gateway records it, so the console can show the log live. */
  Schema.TaggedStruct("captured", { action: OperatorAction }),
  /** A refusal. Carries the rule, because "nothing happened" is not an answer. */
  Schema.TaggedStruct("denied", {
    reason: Schema.String,
    rule: Schema.optional(Schema.String),
  }),
  /** The run took control back and this socket is now read-only. */
  Schema.TaggedStruct("resumed", {
    interventionId: Schema.String,
    disposition: Schema.Literal("retryStep", "skipStep", "abort"),
  }),
  Schema.TaggedStruct("pong", {})
)
export type TakeoverServerMessage = typeof TakeoverServerMessage.Type

export const encodeTakeoverServerMessage = Schema.encode(TakeoverServerMessage)
