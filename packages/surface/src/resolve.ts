import type {
  Anchor,
  AxNode,
  FallbackStrategy,
  FrameObservation,
  Observation,
  Resolution,
  TargetDescriptor,
  TextMatch,
} from "@workspace/contracts"

/**
 * Ranked target resolution over an observation.
 *
 * Pure, and deliberately so: given an observation and a descriptor it always
 * produces the same answer, with no browser involved. That is what makes the
 * hardest part of this system — deciding *which* control a recorded step meant —
 * testable against captured trees rather than against a live page, and it is why
 * the same logic can serve a desktop adapter unchanged.
 *
 * Two rules are enforced here rather than left to callers:
 *
 *  1. **A strategy must match exactly one control.** Matching several is a
 *     failure, not an invitation to take the first. In a banking application,
 *     acting on the wrong control is worse than not acting. Genuine ambiguity has
 *     to be declared in the artifact with `nth`.
 *  2. **The winning rank is always reported**, even on success. A step that used
 *     to resolve by role and now resolves by a fallback still works, but it is
 *     the earliest observable sign that this tenant's UI has moved.
 */

// ── Normalisation ────────────────────────────────────────────────────────

/**
 * Platform role vocabularies differ in spelling, not in meaning. Chromium says
 * `StaticText`, UI Automation says `Text`; both are the same idea. Normalising
 * at the edge keeps the artifact vocabulary small and portable.
 */
export const normalizeRole = (raw: string): string => {
  const role = raw.trim()
  switch (role) {
    case "StaticText":
    case "staticText":
    case "Text":
    case "InlineTextBox":
      return "text"

    /**
     * Chromium reports a *presentational* table — one with no `<th>`, used for
     * layout — as `LayoutTable`/`LayoutTableRow`/`LayoutTableCell` rather than
     * the ARIA roles. Legacy business applications lay out every form this way,
     * so without this mapping the relational anchors that make those forms
     * tractable would never match anything.
     *
     * Note this is invisible through Playwright's `ariaSnapshot`, which reports
     * ARIA roles; only the raw CDP tree shows it.
     */
    case "LayoutTable":
      return "table"
    case "LayoutTableRow":
      return "row"
    case "LayoutTableCell":
      return "cell"

    case "gridcell":
    case "columnheader":
    case "rowheader":
      return "cell"
    case "textField":
    case "searchbox":
      return "textbox"
    case "listbox":
      return "combobox"
    default:
      return role.toLowerCase()
  }
}

/**
 * Whitespace in legacy markup is noise — a label may be split across a `<font>`
 * tag and three newlines — so both sides are collapsed before comparison, and
 * comparison is case-insensitive because tenants re-case labels freely.
 * "Exact" therefore means "the same words", not "the same bytes".
 */
const canonical = (value: string): string =>
  value.replace(/\s+/g, " ").trim().toLowerCase()

export const matchesText = (value: string, match: TextMatch): boolean => {
  const left = canonical(value)
  const right = canonical(match.text)
  return match.exact ? left === right : left.includes(right)
}

/** The text a node contributes to a match. */
const textOf = (node: AxNode): string => node.text ?? node.name

// ── Tree helpers ─────────────────────────────────────────────────────────

interface FrameIndex {
  readonly frame: FrameObservation
  readonly byId: ReadonlyMap<string, AxNode>
}

const indexFrame = (frame: FrameObservation): FrameIndex => ({
  frame,
  byId: new Map(frame.nodes.map((node) => [node.id, node])),
})

const childrenOf = (index: FrameIndex, node: AxNode): readonly AxNode[] =>
  node.childIds.flatMap((id) => {
    const child = index.byId.get(id)
    return child ? [child] : []
  })

const descendantsOf = (index: FrameIndex, node: AxNode): readonly AxNode[] => {
  const out: AxNode[] = []
  const queue = [...childrenOf(index, node)]

  while (queue.length > 0) {
    const next = queue.shift()
    if (!next) break
    out.push(next)
    queue.push(...childrenOf(index, next))
  }

  return out
}

const parentOf = (index: FrameIndex, node: AxNode): AxNode | undefined =>
  node.parentId ? index.byId.get(node.parentId) : undefined

/** Nearest ancestor with the given normalised role. */
const ancestorWithRole = (
  index: FrameIndex,
  node: AxNode,
  role: string
): AxNode | undefined => {
  let current = parentOf(index, node)
  while (current) {
    if (normalizeRole(current.role) === role) return current
    current = parentOf(index, current)
  }
  return undefined
}

// ── Relations ────────────────────────────────────────────────────────────

/**
 * Relations are resolved structurally (through the tree) rather than
 * geometrically (through coordinates).
 *
 * For the table-based layouts this system exists to automate, structure is both
 * more available and more stable: a cell is in a row whether or not the page has
 * been laid out, and it stays in that row when the stylesheet changes. Geometry
 * is the better answer for absolutely positioned modern UIs, and is the natural
 * place to extend this — the node bounds are already carried on the observation.
 */
const relatedCandidates = (
  index: FrameIndex,
  anchorNode: AxNode,
  relation: Anchor["relation"]
): readonly AxNode[] => {
  if (relation === "within") return descendantsOf(index, anchorNode)

  const parent = parentOf(index, anchorNode)
  if (!parent) return []

  const siblings = childrenOf(index, parent)
  const position = siblings.findIndex((sibling) => sibling.id === anchorNode.id)
  if (position < 0) return []

  if (relation === "rightOf" || relation === "leftOf") {
    // Nearest first, so a declared `nth` counts outward from the anchor.
    const inDirection =
      relation === "rightOf"
        ? siblings.slice(position + 1)
        : siblings.slice(0, position).reverse()

    return inDirection.flatMap((sibling) => [
      sibling,
      ...descendantsOf(index, sibling),
    ])
  }

  // Vertical relations need the grid: same column, adjacent row.
  const row =
    normalizeRole(parent.role) === "row"
      ? parent
      : ancestorWithRole(index, anchorNode, "row")
  if (!row) return []

  const table = ancestorWithRole(index, row, "table")
  if (!table) return []

  const rows = childrenOf(index, table).filter(
    (node) => normalizeRole(node.role) === "row"
  )
  const rowPosition = rows.findIndex((candidate) => candidate.id === row.id)
  if (rowPosition < 0) return []

  const targetRow =
    relation === "below" ? rows[rowPosition + 1] : rows[rowPosition - 1]
  if (!targetRow) return []

  const column = childrenOf(index, row).findIndex(
    (cell) => cell.id === anchorNode.id
  )
  const cell = childrenOf(index, targetRow)[column]

  return cell ? [cell, ...descendantsOf(index, cell)] : []
}

// ── Strategy plan ────────────────────────────────────────────────────────

export type PlanEntry =
  | { readonly kind: "roleAndName"; readonly rank: number }
  | {
      readonly kind: "anchor"
      readonly rank: number
      readonly index: number
      readonly anchor: Anchor
    }
  | {
      readonly kind: "fallback"
      readonly rank: number
      readonly index: number
      readonly strategy: FallbackStrategy
    }

/**
 * The single ordered list of strategies, shared by the pure resolver and the
 * adapter that executes the markup fallbacks. Both halves read ranks from here,
 * so a rank means the same thing wherever it is reported.
 */
export const buildPlan = (
  descriptor: TargetDescriptor
): readonly PlanEntry[] => {
  const entries: PlanEntry[] = []

  // Role is a *filter*, applied to whatever every strategy turns up; the name is
  // what makes role+name a strategy. Treating a bare role as a strategy would
  // match every control of that kind on the page, which is ambiguous by
  // construction and would pre-empt the anchors that could actually resolve it.
  if (descriptor.name)
    entries.push({ kind: "roleAndName", rank: entries.length })

  descriptor.anchors.forEach((anchor, index) => {
    entries.push({ kind: "anchor", rank: entries.length, index, anchor })
  })

  descriptor.fallbacks.forEach((strategy, index) => {
    entries.push({ kind: "fallback", rank: entries.length, index, strategy })
  })

  return entries
}

// ── Resolution ───────────────────────────────────────────────────────────

export type ObservationResolution =
  | {
      readonly _tag: "resolved"
      readonly node: AxNode
      readonly frame: readonly string[]
      readonly resolution: Resolution
    }
  | {
      readonly _tag: "ambiguous"
      readonly matchCount: number
      readonly rank: number
    }
  /** No accessibility strategy matched; the adapter may still try markup fallbacks. */
  | { readonly _tag: "exhausted"; readonly ranksTried: number }

const framesToSearch = (
  observation: Observation,
  descriptor: TargetDescriptor
): readonly FrameIndex[] => {
  // An explicit path means that document and no other. An empty path means the
  // descriptor does not care, so uniqueness is enforced across every frame —
  // which is stricter than guessing the top document, and catches a name that
  // is only ambiguous once you look at the whole page.
  const frames =
    descriptor.frame.length === 0
      ? observation.frames
      : observation.frames.filter(
          (frame) =>
            frame.path.length === descriptor.frame.length &&
            frame.path.every((segment, i) => segment === descriptor.frame[i])
        )

  return frames.map(indexFrame)
}

/**
 * `role` constrains every strategy. `name` constrains only the role+name
 * strategy — an anchor exists precisely because the control's name does not
 * identify it (usually because it has none), so re-applying the name to an
 * anchor's candidates would reject the very control the anchor found.
 */
const matchesDescriptorShape = (
  node: AxNode,
  descriptor: TargetDescriptor,
  applyName: boolean
): boolean => {
  if (descriptor.role && normalizeRole(node.role) !== descriptor.role)
    return false
  if (applyName && descriptor.name && !matchesText(node.name, descriptor.name))
    return false
  return true
}

/**
 * Try every accessibility-tree strategy in rank order and stop at the first that
 * matches exactly one control.
 */
export const resolveInObservation = (
  observation: Observation,
  descriptor: TargetDescriptor
): ObservationResolution => {
  const plan = buildPlan(descriptor)
  const indexes = framesToSearch(observation, descriptor)

  for (const entry of plan) {
    if (entry.kind === "fallback") continue // markup queries belong to the adapter

    const hits: { node: AxNode; frame: readonly string[] }[] = []

    for (const index of indexes) {
      const candidates =
        entry.kind === "roleAndName"
          ? index.frame.nodes
          : index.frame.nodes
              .filter(
                (node) =>
                  (!entry.anchor.role ||
                    normalizeRole(node.role) === entry.anchor.role) &&
                  matchesText(textOf(node), entry.anchor.match)
              )
              .flatMap((anchorNode) =>
                relatedCandidates(index, anchorNode, entry.anchor.relation)
              )

      for (const node of candidates) {
        if (
          !matchesDescriptorShape(
            node,
            descriptor,
            entry.kind === "roleAndName"
          )
        )
          continue
        if (hits.some((hit) => hit.node.id === node.id)) continue
        hits.push({ node, frame: index.frame.path })
      }
    }

    if (hits.length === 0) continue

    const chosen =
      hits.length === 1
        ? hits[0]
        : descriptor.nth !== undefined
          ? hits[descriptor.nth]
          : undefined

    if (!chosen) {
      // Several controls matched and the artifact did not say which. Refusing
      // here is the whole point: silently taking the first is how automation
      // ends up acting on the wrong row.
      return { _tag: "ambiguous", matchCount: hits.length, rank: entry.rank }
    }

    return {
      _tag: "resolved",
      node: chosen.node,
      frame: chosen.frame,
      resolution: {
        strategy:
          entry.kind === "roleAndName"
            ? { _tag: "roleAndName" }
            : { _tag: "anchor", index: entry.index },
        rank: entry.rank,
        matchCount: hits.length,
      },
    }
  }

  return {
    _tag: "exhausted",
    ranksTried: plan.filter((e) => e.kind !== "fallback").length,
  }
}
