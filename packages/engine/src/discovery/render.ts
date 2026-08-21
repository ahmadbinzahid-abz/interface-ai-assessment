import type {
  AxNode,
  FrameObservation,
  Observation,
} from "@workspace/contracts"
import { normalizeRole } from "@workspace/surface"

import { inferAnchor } from "./descriptor.js"

/**
 * Rendering an observation for the model.
 *
 * The model gets a numbered list of controls and the page's readable text, not
 * markup and not raw accessibility JSON. Three reasons, in order of importance:
 *
 *  1. **It removes the chance to write a locator.** The model can only point at
 *     `#7`; the recorder decides how `#7` is described durably. The most brittle
 *     decision in the system stays out of the least deterministic hands.
 *  2. **It is what a person sees.** A control's role, its visible name, and the
 *     label beside it is the whole basis on which an operator finds a field.
 *  3. **It is a fraction of the tokens** of the equivalent DOM, which is what
 *     makes a multi-step discovery run affordable.
 */

export interface RenderedControl {
  readonly ref: number
  readonly framePath: readonly string[]
  readonly node: AxNode
  readonly role: string
  readonly name: string
  /** The label a human would read it by, when the control has no name of its own. */
  readonly label?: string
}

export interface RenderedObservation {
  readonly text: string
  readonly controls: readonly RenderedControl[]
}

/** Controls worth offering as an action target. */
const INTERACTIVE = new Set([
  "button",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "link",
  "menuitem",
  "tab",
])

/** Roles worth offering as an extraction target. */
const READABLE = new Set(["cell", "heading", "alert"])

const isReferenceable = (node: AxNode): boolean => {
  const role = normalizeRole(node.role)
  if (INTERACTIVE.has(role)) return true
  // Only cells that actually carry text are useful to point at.
  return (
    READABLE.has(role) &&
    (node.name.trim().length > 0 || (node.text?.trim().length ?? 0) > 0)
  )
}

const displayText = (node: AxNode): string => (node.text ?? node.name).trim()

/**
 * The page's readable content, in document order and de-duplicated.
 *
 * This is what lets the model notice "No member found for 99999" — the state
 * that has to become a declared business outcome rather than a crash.
 */
const frameText = (frame: FrameObservation): string => {
  const seen = new Set<string>()
  const lines: string[] = []

  for (const node of frame.nodes) {
    const role = normalizeRole(node.role)
    if (
      role !== "text" &&
      role !== "cell" &&
      role !== "heading" &&
      role !== "alert"
    )
      continue

    const text = displayText(node)
    if (text.length === 0 || seen.has(text)) continue

    seen.add(text)
    lines.push(text)
  }

  return lines.join(" | ")
}

export const renderObservation = (
  observation: Observation
): RenderedObservation => {
  const controls: RenderedControl[] = []
  const sections: string[] = [
    `URL: ${observation.url}`,
    `TITLE: ${observation.title}`,
  ]

  let ref = 1

  for (const frame of observation.frames) {
    const referenceable = frame.nodes.filter(isReferenceable)
    const text = frameText(frame)

    // A frame with nothing to read and nothing to touch is noise.
    if (referenceable.length === 0 && text.length === 0) continue

    const label =
      frame.path.length === 0
        ? "main document"
        : `frame "${frame.path.join(" > ")}"`
    const lines = [``, `--- ${label} (${frame.url}) ---`]

    if (text.length > 0) lines.push(`text: ${text}`)

    for (const node of referenceable) {
      const role = normalizeRole(node.role)
      const name = node.name.trim()
      const anchorLabel =
        name.length === 0 ? inferAnchor(frame, node)?.match.text : undefined

      controls.push({
        ref,
        framePath: frame.path,
        node,
        role,
        name,
        label: anchorLabel,
      })

      const shown =
        name.length > 0
          ? `"${name}"`
          : anchorLabel
            ? `(unnamed, labelled "${anchorLabel}")`
            : "(unnamed)"

      const value = node.value ? ` value="${node.value}"` : ""
      const state = node.disabled ? " [disabled]" : ""

      lines.push(`  #${ref}  ${role.padEnd(9)} ${shown}${value}${state}`)
      ref++
    }

    sections.push(lines.join("\n"))
  }

  return { text: sections.join("\n"), controls }
}

export const findControl = (
  rendered: RenderedObservation,
  ref: number
): RenderedControl | undefined =>
  rendered.controls.find((control) => control.ref === ref)
