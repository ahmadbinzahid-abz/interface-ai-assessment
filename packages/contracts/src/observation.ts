import { Schema } from "effect"

/**
 * What the system perceives, in the one form every surface can produce.
 *
 * This is the accessibility tree, not the DOM. That choice is the seam the whole
 * design rests on:
 *
 *  - it exists everywhere we need to go — Chromium exposes it over CDP, Windows
 *    exposes the same concepts through UI Automation, macOS through the AX API.
 *    A desktop adapter fills in this same type, so descriptors and recorded flows
 *    do not have to know which kind of surface they came from.
 *  - it is what a human operator perceives: a control has a role and, if it is
 *    well built, a name. Legacy apps often give a field no name at all, which is
 *    honest information — it tells the resolver to fall back to relations.
 *  - it is an order of magnitude smaller than raw markup, which matters when the
 *    discovery loop is paying per token to look at it.
 *
 * A screenshot is captured alongside for evidence and for the vision fallback
 * during discovery, but never for targeting: pixels cannot be re-resolved
 * deterministically, and deterministic replay is the point.
 */

export const NodeBounds = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
})
export type NodeBounds = typeof NodeBounds.Type

export class AxNode extends Schema.Class<AxNode>("AxNode")({
  id: Schema.String,
  /** Raw role as reported by the platform, normalised by the adapter where it can be. */
  role: Schema.String,
  /** Empty string is meaningful: the control genuinely has no accessible name. */
  name: Schema.String,
  value: Schema.optional(Schema.String),
  /** Text content, for nodes that carry it (cells, headings, static text). */
  text: Schema.optional(Schema.String),
  disabled: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  focusable: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  parentId: Schema.optional(Schema.String),
  childIds: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),
  bounds: Schema.optional(NodeBounds),
  /**
   * The platform handle for this node, so the adapter can act on it without
   * re-querying. Meaningless outside the adapter that produced it, which is why
   * it is a bare number rather than something the artifact could ever reference.
   */
  handle: Schema.optional(Schema.Number),
}) {}

/**
 * One document. A frameset produces several, and a control in `contentFrame` is
 * a different control from one of the same name in `navFrame` — so every
 * observation is explicitly partitioned by frame rather than flattened.
 */
export class FrameObservation extends Schema.Class<FrameObservation>(
  "FrameObservation"
)({
  /** Frame names from the top document down. Empty for the top document itself. */
  path: Schema.Array(Schema.String),
  url: Schema.String,
  nodes: Schema.Array(AxNode),
}) {}

export class Observation extends Schema.Class<Observation>("Observation")({
  url: Schema.String,
  title: Schema.String,
  capturedAt: Schema.String,
  frames: Schema.Array(FrameObservation),
  /** Path to the captured screenshot, if one was taken. Redacted before writing. */
  screenshotRef: Schema.optional(Schema.String),
  /** Status of the last navigation, where the adapter can observe it. */
  httpStatus: Schema.optional(Schema.Number),
}) {}

/** Every node across every frame, for whole-page text searches. */
export const allNodes = (observation: Observation): readonly AxNode[] =>
  observation.frames.flatMap((frame) => frame.nodes)

export const frameAt = (
  observation: Observation,
  path: readonly string[]
): FrameObservation | undefined =>
  observation.frames.find(
    (frame) =>
      frame.path.length === path.length &&
      frame.path.every((segment, index) => segment === path[index])
  )

/** The visible text a node contributes, whichever field carries it. */
export const nodeText = (node: AxNode): string => node.text ?? node.name ?? ""
