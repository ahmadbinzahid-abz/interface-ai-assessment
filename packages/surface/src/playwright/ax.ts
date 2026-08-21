import { AxNode, FrameObservation, Observation } from "@workspace/contracts"
import type { CDPSession, Page } from "playwright"

/**
 * Reading the accessibility tree out of Chromium.
 *
 * The one non-obvious thing here, and it cost a probe to find out: for a
 * frameset you must walk `Page.getFrameTree` and call
 * `Accessibility.getFullAXTree({ frameId })` once per frame.
 *
 * The two approaches that look right are both wrong. Calling `getFullAXTree`
 * on the page session returns only the top document — for a frameset that is
 * *zero* interactive controls, because all the content is in the children. And
 * `newCDPSession(frame)` throws "This frame does not have a separate CDP
 * session" for same-origin frames, which these always are.
 */

interface DiscoveredFrame {
  readonly id: string
  /** Frame names from the top document down. Empty for the top document. */
  readonly path: readonly string[]
  readonly url: string
}

/** Flattens the CDP frame tree, naming each frame by its path from the root. */
const flattenFrameTree = (
  node: {
    frame: { id: string; name?: string; url: string }
    childFrames?: unknown[]
  },
  parentPath: readonly string[],
  isRoot: boolean
): DiscoveredFrame[] => {
  const path = isRoot
    ? []
    : // An unnamed frame still needs a stable identity within its parent.
      [
        ...parentPath,
        node.frame.name && node.frame.name.length > 0
          ? node.frame.name
          : node.frame.id,
      ]

  const self: DiscoveredFrame = { id: node.frame.id, path, url: node.frame.url }

  const children = (node.childFrames ?? []) as Parameters<
    typeof flattenFrameTree
  >[0][]

  return [
    self,
    ...children.flatMap((child) => flattenFrameTree(child, path, false)),
  ]
}

const stringValue = (
  value: { value?: unknown } | undefined
): string | undefined => {
  const raw = value?.value
  return typeof raw === "string" ? raw : undefined
}

const boolProperty = (
  properties:
    | readonly { name: string; value: { value?: unknown } }[]
    | undefined,
  name: string
): boolean => {
  const property = properties?.find((candidate) => candidate.name === name)
  return property?.value.value === true
}

/**
 * Ignored nodes are kept deliberately.
 *
 * They are invisible to assistive technology, but they are load-bearing
 * *structure* — dropping them would sever the parent chain that relational
 * anchors walk to get from a label cell to the field beside it. The resolver
 * filters by role, so they never match a target on their own.
 */
export const readObservation = async (
  page: Page,
  cdp: CDPSession,
  httpStatus?: number
): Promise<Observation> => {
  const { frameTree } = await cdp.send("Page.getFrameTree")
  const frames = flattenFrameTree(frameTree, [], true)

  const observed: FrameObservation[] = []

  for (const frame of frames) {
    let nodes: AxNode[] = []

    try {
      const { nodes: axNodes } = await cdp.send("Accessibility.getFullAXTree", {
        frameId: frame.id,
      })

      nodes = axNodes.map(
        (node) =>
          new AxNode({
            id: node.nodeId,
            role: stringValue(node.role) ?? "",
            name: stringValue(node.name) ?? "",
            value: stringValue(node.value),
            text: undefined,
            disabled: boolProperty(node.properties, "disabled"),
            focusable: boolProperty(node.properties, "focusable"),
            parentId: node.parentId,
            childIds: node.childIds ?? [],
            handle: node.backendDOMNodeId,
          })
      )
    } catch {
      // A frame can be torn down between the tree walk and the query. An empty
      // frame is a truthful observation; failing the whole capture is not.
      nodes = []
    }

    observed.push(
      new FrameObservation({ path: frame.path, url: frame.url, nodes })
    )
  }

  return new Observation({
    url: page.url(),
    title: await page.title().catch(() => ""),
    capturedAt: new Date().toISOString(),
    frames: observed,
    httpStatus,
  })
}

export type { DiscoveredFrame }
