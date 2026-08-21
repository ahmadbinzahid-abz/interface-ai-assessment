import {
  TargetDescriptor,
  type Anchor,
  type AxNode,
  type ControlRole,
  type FrameObservation,
  type NodeBounds,
  type Observation,
} from "@workspace/contracts"
import {
  matchesText,
  normalizeRole,
  resolveInObservation,
} from "@workspace/surface"

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
export const inferAnchors = (
  frame: FrameObservation,
  node: AxNode
): readonly Anchor[] => {
  const byId = indexOf(frame)

  const cell = ancestorCell(byId, node)
  if (!cell) return []

  const row = parentOf(byId, cell)
  if (!row) return []

  const cells = row.childIds
    .map((id) => byId.get(id))
    .filter((child): child is AxNode => child !== undefined)

  const position = cells.findIndex((candidate) => candidate.id === cell.id)
  if (position <= 0) return []

  const anchors: Anchor[] = []

  for (let i = position - 1; i >= 0; i--) {
    const candidate = cells[i]
    const text = candidate?.name.trim()
    if (candidate && text) {
      anchors.push({
        relation: "rightOf",
        role: "cell",
        match: { text, exact: true },
      })
    }
  }

  /**
   * Prefer an anchor that is itself unique on the page.
   *
   * Nearest-first is the obvious ordering and the wrong one. In an accounts
   * table the cell immediately left of a balance is the opening date, which
   * every account opened that day shares; the account number two cells over
   * occurs once. Both can be made to resolve by adding an `nth`, so uniqueness
   * of the *anchor* is what separates a landmark from a coincidence — and it is
   * what keeps the descriptor working when a row is added above.
   */
  const occurrences = (anchor: Anchor): number =>
    frame.nodes.filter(
      (candidate) =>
        (!anchor.role || normalizeRole(candidate.role) === anchor.role) &&
        matchesText(candidate.name, anchor.match)
    ).length

  return [...anchors].sort((a, b) => {
    const uniqueA = occurrences(a) === 1 ? 0 : 1
    const uniqueB = occurrences(b) === 1 ? 0 : 1
    return uniqueA - uniqueB
  })
}

/** The nearest labelled cell to the left, for rendering a control's label. */
export const inferAnchor = (
  frame: FrameObservation,
  node: AxNode
): Anchor | undefined => inferAnchors(frame, node)[0]

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
  /**
   * Set when the control is being read *for its value* rather than acted on.
   *
   * A balance cell reads "$4,812.65" today, so naming it that identifies the
   * answer rather than the control, and the capability would only ever resolve
   * for a member whose balance happens to match. The name is dropped — but only
   * if an anchor can be found that still resolves to exactly this node, which is
   * checkable here because the page is in front of us.
   */
  readonly identifiesByValue?: boolean
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
  identifiesByValue = false,
}: SynthesisInput): TargetDescriptor => {
  const frame = observation.frames.find(
    (candidate) =>
      candidate.path.length === framePath.length &&
      candidate.path.every((segment, i) => segment === framePath[i])
  )

  const role = asControlRole(node.role)
  const name = node.name.trim()
  const anchorCandidates = frame ? inferAnchors(frame, node) : []

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

  const build = (anchors: readonly Anchor[]) =>
    new TargetDescriptor({
      description,
      frame: framePath,
      role,
      name: name.length > 0 ? { text: name, exact: true } : undefined,
      anchors,
      fallbacks,
    })

  /**
   * Prefer an anchor that identifies the control on its own.
   *
   * Each candidate is tried against the observation the step was recorded from,
   * and the first that resolves to exactly this node wins. That is what turns
   * "the cell right of the opening date" — which matches every row opened that
   * day — into "the cell right of account number S-0001-12345", which matches
   * one. Doing this here rather than in the compiler matters: the page is in
   * front of us, so the choice can be *verified* instead of guessed.
   */
  const resolvesToThisNode = (candidate: TargetDescriptor): boolean => {
    const resolved = resolveInObservation(observation, candidate)
    return resolved._tag === "resolved" && resolved.node.id === node.id
  }

  // An extraction target identified without its value, if that still works.
  if (identifiesByValue) {
    for (const anchor of anchorCandidates) {
      const base = new TargetDescriptor({
        description,
        frame: framePath,
        role,
        anchors: [anchor],
        fallbacks,
      })

      /**
       * `rightOf` means every cell to the right, not the next one, so anchoring
       * a balance on its account number legitimately matches two cells — the
       * date and the balance. That is declared ambiguity, and `nth` is how the
       * schema expresses it, so the same narrowing used elsewhere applies here
       * before the candidate is judged.
       */
      const candidate = disambiguate(observation, base, node.id)
      if (resolvesToThisNode(candidate)) return candidate
    }
  }

  for (const anchor of anchorCandidates) {
    const candidate = build([anchor])
    if (resolvesToThisNode(candidate)) return candidate
  }

  return disambiguate(observation, build(anchorCandidates.slice(0, 1)), node.id)
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
