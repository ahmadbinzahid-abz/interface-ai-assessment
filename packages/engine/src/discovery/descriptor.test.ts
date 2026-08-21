import { AxNode, FrameObservation, Observation } from "@workspace/contracts"
import { resolveInObservation } from "@workspace/surface"
import { describe, expect, it } from "vitest"

import { synthesizeDescriptor } from "./descriptor.js"

/**
 * How a recorded step describes the control it acted on.
 *
 * This is where an artifact's reusability is decided, and the failures are
 * subtle: a descriptor that works perfectly for the record it was recorded
 * against and for nothing else. These cases come from real recordings.
 */

interface Spec {
  role: string
  name?: string
  children?: Spec[]
}

const flatten = (spec: Spec): AxNode[] => {
  const nodes: AxNode[] = []
  let next = 0

  const walk = (current: Spec, parentId?: string): string => {
    const id = `n${next++}`
    const childIds: string[] = []
    for (const child of current.children ?? []) childIds.push(walk(child, id))

    nodes.push(
      new AxNode({
        id,
        role: current.role,
        name: current.name ?? "",
        parentId,
        childIds,
        disabled: false,
        focusable: false,
      })
    )
    return id
  }

  walk(spec)
  return nodes
}

/** The accounts table, with two rows sharing an opening date. */
const accountsPage = (): Observation => {
  const nodes = flatten({
    role: "table",
    children: [
      {
        role: "row",
        children: [
          { role: "cell", name: "Savings" },
          { role: "cell", name: "S-0001-12345" },
          { role: "cell", name: "2019-03-11" },
          { role: "cell", name: "$4,812.65" },
        ],
      },
      {
        role: "row",
        children: [
          { role: "cell", name: "Checking" },
          { role: "cell", name: "C-0002-12345" },
          { role: "cell", name: "2019-03-11" },
          { role: "cell", name: "$1,204.10" },
        ],
      },
    ],
  })

  return new Observation({
    url: "http://localhost:4100/firstcity/desk/member/12345",
    title: "Member 12345",
    capturedAt: "2026-08-21T00:00:00.000Z",
    frames: [
      new FrameObservation({
        path: ["contentFrame"],
        url: "http://x/member",
        nodes,
      }),
    ],
  })
}

const balanceCell = (observation: Observation): AxNode => {
  const node = observation.frames[0]?.nodes.find((n) => n.name === "$4,812.65")
  if (!node) throw new Error("fixture is wrong")
  return node
}

describe("synthesising a target for an extraction", () => {
  /**
   * The bug this prevents: a recorded capability that reads a balance by looking
   * for the balance it read during discovery. It replays perfectly for the member
   * it was recorded with, and fails for every other one.
   */
  it("does not identify a cell by the value it is about to extract", () => {
    const observation = accountsPage()

    const descriptor = synthesizeDescriptor({
      observation,
      framePath: ["contentFrame"],
      node: balanceCell(observation),
      description: "cell holding savingsBalance",
      identifiesByValue: true,
    })

    expect(descriptor.name).toBeUndefined()
    // Nothing the resolver uses may mention the value.
    expect(JSON.stringify(descriptor.anchors)).not.toContain("4,812.65")
    expect(JSON.stringify(descriptor.fallbacks)).not.toContain("4,812.65")
  })

  it("anchors on something that actually identifies the row", () => {
    const observation = accountsPage()

    const descriptor = synthesizeDescriptor({
      observation,
      framePath: ["contentFrame"],
      node: balanceCell(observation),
      description: "cell holding savingsBalance",
      identifiesByValue: true,
    })

    // The opening date is the nearest label but is shared by both rows; the
    // account number is what distinguishes this one.
    expect(descriptor.anchors[0]?.match.text).toBe("S-0001-12345")
  })

  it("still resolves to exactly the cell it was recorded from", () => {
    const observation = accountsPage()
    const node = balanceCell(observation)

    const descriptor = synthesizeDescriptor({
      observation,
      framePath: ["contentFrame"],
      node,
      description: "cell holding savingsBalance",
      identifiesByValue: true,
    })

    const resolved = resolveInObservation(observation, descriptor)

    expect(resolved._tag).toBe("resolved")
    if (resolved._tag !== "resolved") return
    expect(resolved.node.id).toBe(node.id)
  })

  it("keeps the name when the control is being acted on rather than read", () => {
    const observation = accountsPage()

    const descriptor = synthesizeDescriptor({
      observation,
      framePath: ["contentFrame"],
      node: balanceCell(observation),
      description: "some cell",
      identifiesByValue: false,
    })

    expect(descriptor.name?.text).toBe("$4,812.65")
  })
})
