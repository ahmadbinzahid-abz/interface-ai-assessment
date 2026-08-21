import {
  TargetDescriptor,
  type Anchor,
  type AxNode,
  type ControlRole,
  type FrameObservation,
  type NodeBounds,
  type Observation,
} from "@workspace/contracts"
import { normalizeRole, resolveInObservation } from "@workspace/surface"

/**
 * Turning "the model acted on *that* control" into a durable descriptor.
 *
 * This is where the quality of a recorded artifact is decided. The model never
 * authors a locator — it points at a numbered control it can see, and the
 * recorder works out how to describe that control in a way that will still find
 * it next month. Asking a model to write selectors would put the most brittle
 * part of the system in the least deterministic hands.
 *
 * The descriptor is then **verified against the observation it was recorded
 * from**: if it does not resolve back to exactly the node the model acted on,
 * it is narrowed until it does. A recorded step that was ambiguous the moment it
 * was written would be a latent production failure.
 */

/** Roles the artifact vocabulary can express. Anything else is recorded role-less. */
const KNOWN_ROLES = new Set<string>([
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
  "text",
])

const asControlRole = (raw: string): ControlRole | undefined => {
  const role = normalizeRole(raw)
  return KNOWN_ROLES.has(role) ? (role as ControlRole) : undefined
}

const indexOf = (frame: FrameObservation): Map<string, AxNode> =>
  new Map(frame.nodes.map((node) => [node.id, node]))

const parentOf = (
  byId: Map<string, AxNode>,
  node: AxNode
): AxNode | undefined => (node.parentId ? byId.get(node.parentId) : undefined)

const ancestorCell = (
  byId: Map<string, AxNode>,
  node: AxNode
): AxNode | undefined => {
  let current: AxNode | undefined = node
  while (current) {
    if (normalizeRole(current.role) === "cell") return current
    current = parentOf(byId, current)
  }
  return undefined
}

/**
 * Find the label a human would read this control by.
 *
 * In these applications the label is the text of the cell to the left, so that
 * is what is looked for: the control's own cell, then the nearest preceding
 * sibling cell carrying text. Recording the *relation* rather than the label's
 * coordinates is what makes the descriptor survive a tenant adding a column.
 */
export const inferAnchor = (
  frame: FrameObservation,
  node: AxNode
): Anchor | undefined => {
  const byId = indexOf(frame)

  const cell = ancestorCell(byId, node)
  if (!cell) return undefined

  const row = parentOf(byId, cell)
  if (!row) return undefined

  const cells = row.childIds
    .map((id) => byId.get(id))
    .filter((child): child is AxNode => child !== undefined)

  const position = cells.findIndex((candidate) => candidate.id === cell.id)
  if (position <= 0) return undefined

  for (let i = position - 1; i >= 0; i--) {
    const candidate = cells[i]
    const text = candidate?.name.trim()
    if (candidate && text) {
      return { relation: "rightOf", role: "cell", match: { text, exact: true } }
    }
  }

  return undefined
}

export interface SynthesisInput {
  readonly observation: Observation
  readonly framePath: readonly string[]
  readonly node: AxNode
  /** The model's own words for what it acted on, kept for human reviewers. */
  readonly description: string
  /** DOM attributes of the element, when the adapter could read them. */
  readonly attributes?: Record<string, string>
  readonly bounds?: NodeBounds
  readonly viewport?: { readonly width: number; readonly height: number }
}

/**
 * Build the ranked descriptor, then prove it resolves back to this exact node.
 */
export const synthesizeDescriptor = ({
  observation,
  framePath,
  node,
  description,
  attributes,
  bounds,
  viewport,
}: SynthesisInput): TargetDescriptor => {
  const frame = observation.frames.find(
    (candidate) =>
      candidate.path.length === framePath.length &&
      candidate.path.every((segment, i) => segment === framePath[i])
  )

  const role = asControlRole(node.role)
  const name = node.name.trim()
  const anchor = frame ? inferAnchor(frame, node) : undefined

  const fallbacks: TargetDescriptor["fallbacks"][number][] = []

  // The legacy control name: meaningless to a person, but empirically stable
  // across tenants running the same vendor build, so it makes a good safety net.
  const controlName = attributes?.["name"]
  if (controlName) fallbacks.push({ _tag: "controlName", name: controlName })

  if (attributes?.["id"]) {
    fallbacks.push({
      _tag: "css",
      selector: `#${CSS_ESCAPE(attributes["id"])}`,
    })
  }

  // Coordinates last: they survive no layout change at all, but they are the one
  // strategy that still works on a surface with no queryable structure.
  if (bounds && viewport) {
    fallbacks.push({
      _tag: "point",
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
      viewport,
    })
  }

  const base = new TargetDescriptor({
    description,
    frame: framePath,
    role,
    name: name.length > 0 ? { text: name, exact: true } : undefined,
    anchors: anchor ? [anchor] : [],
    fallbacks,
  })

  return disambiguate(observation, base, node.id)
}

/**
 * A descriptor that matches several controls is not a recording, it is a guess.
 *
 * If the synthesised descriptor is ambiguous against the very observation it came
 * from, the correct `nth` is found and declared. Declaring it makes the ambiguity
 * visible to a reviewer, which silently taking the first match would not.
 */
const disambiguate = (
  observation: Observation,
  descriptor: TargetDescriptor,
  nodeId: string
): TargetDescriptor => {
  const direct = resolveInObservation(observation, descriptor)

  if (direct._tag === "resolved" && direct.node.id === nodeId) return descriptor

  if (direct._tag === "ambiguous") {
    for (let nth = 0; nth < direct.matchCount; nth++) {
      const candidate = new TargetDescriptor({ ...descriptor, nth })
      const resolved = resolveInObservation(observation, candidate)
      if (resolved._tag === "resolved" && resolved.node.id === nodeId)
        return candidate
    }
  }

  // Nothing narrowed it. The descriptor is still returned — replay will report
  // honestly if it cannot resolve — but the ranked fallbacks are what will carry
  // it, and that shows up immediately in the rank telemetry.
  return descriptor
}

/** Minimal CSS identifier escaping; `CSS.escape` is not available in Node. */
const CSS_ESCAPE = (value: string): string => value.replace(/([^\w-])/g, "\\$1")
