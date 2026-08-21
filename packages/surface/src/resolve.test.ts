import {
  AxNode,
  FrameObservation,
  Observation,
  TargetDescriptor,
} from "@workspace/contracts"
import { describe, expect, it } from "vitest"

import {
  buildPlan,
  matchesText,
  normalizeRole,
  resolveInObservation,
} from "./resolve.js"

/**
 * These run against accessibility trees shaped exactly like the ones captured
 * from the real stand-in app — an unnamed textbox in the cell beside its label,
 * a submit button that does have a name, and a frameset that splits the page in
 * two. Testing the resolver against a captured tree rather than a live browser is
 * the payoff for keeping it pure: the hard part of the system is checked in
 * milliseconds and with no flakiness.
 */

// ── Tree building ────────────────────────────────────────────────────────

interface Spec {
  role: string
  name?: string
  text?: string
  children?: Spec[]
}

/** Flattens a nested spec into the parent/child id form an AX tree really has. */
const flatten = (spec: Spec, prefix = "n"): AxNode[] => {
  const nodes: AxNode[] = []
  let next = 0

  const walk = (current: Spec, parentId?: string): string => {
    const id = `${prefix}${next++}`
    const childIds: string[] = []

    // Reserve this node's slot before recursing so ids read top-down.
    const node = { id, parentId, childIds } as {
      id: string
      parentId?: string
      childIds: string[]
    }

    for (const child of current.children ?? []) {
      childIds.push(walk(child, id))
    }

    nodes.push(
      new AxNode({
        id: node.id,
        role: current.role,
        name: current.name ?? "",
        text: current.text,
        parentId: node.parentId,
        childIds: node.childIds,
        disabled: false,
        focusable: false,
      })
    )

    return id
  }

  walk(spec)
  return nodes
}

const frame = (
  path: readonly string[],
  spec: Spec,
  prefix?: string
): FrameObservation =>
  new FrameObservation({
    path,
    url: `http://localhost:4100/${path.join("/")}`,
    nodes: flatten(spec, prefix),
  })

const observe = (...frames: FrameObservation[]): Observation =>
  new Observation({
    url: "http://localhost:4100/firstcity/desk",
    title: "Servicing Desk",
    capturedAt: "2026-08-21T00:00:00.000Z",
    frames,
  })

const descriptor = (
  fields: Partial<ConstructorParameters<typeof TargetDescriptor>[0]>
) =>
  new TargetDescriptor({
    description: "test target",
    frame: [],
    anchors: [],
    fallbacks: [],
    ...fields,
  })

// ── Fixtures mirroring the real app ──────────────────────────────────────

/** The search page: a label cell, an unnamed textbox beside it, a named button. */
const searchFrame = frame(["contentFrame"], {
  role: "table",
  children: [
    {
      role: "row",
      name: "Member Number",
      children: [
        { role: "cell", name: "Member Number" },
        { role: "cell", children: [{ role: "textbox", name: "" }] },
      ],
    },
    {
      role: "row",
      name: "Search",
      children: [
        { role: "cell" },
        {
          role: "cell",
          name: "Search",
          children: [{ role: "button", name: "Search" }],
        },
      ],
    },
  ],
})

const navFrame = frame(
  ["navFrame"],
  { role: "list", children: [{ role: "link", name: "Member Search" }] },
  "m"
)

describe("normalizeRole", () => {
  it("folds platform spellings onto one vocabulary", () => {
    expect(normalizeRole("StaticText")).toBe("text")
    expect(normalizeRole("Text")).toBe("text")
    expect(normalizeRole("gridcell")).toBe("cell")
    expect(normalizeRole("columnheader")).toBe("cell")
    expect(normalizeRole("searchbox")).toBe("textbox")
    expect(normalizeRole("Button")).toBe("button")
  })

  /**
   * Chromium reports layout tables under their own roles. Every form in the
   * target application is a layout table, so getting this wrong means no anchor
   * ever resolves — and it is invisible through `ariaSnapshot`, which shows ARIA
   * roles rather than the raw tree the adapter actually reads.
   */
  it("maps Chromium's presentational table roles onto the real ones", () => {
    expect(normalizeRole("LayoutTable")).toBe("table")
    expect(normalizeRole("LayoutTableRow")).toBe("row")
    expect(normalizeRole("LayoutTableCell")).toBe("cell")
  })
})

describe("matchesText", () => {
  it("ignores the whitespace legacy markup scatters through labels", () => {
    expect(
      matchesText("  Member \n  Number ", {
        text: "Member Number",
        exact: true,
      })
    ).toBe(true)
  })

  it("ignores case, because tenants re-case labels freely", () => {
    expect(
      matchesText("MEMBER NUMBER", { text: "Member Number", exact: true })
    ).toBe(true)
  })

  it("still distinguishes different words when exact", () => {
    expect(matchesText("Member Number", { text: "Member", exact: true })).toBe(
      false
    )
    expect(matchesText("Member Number", { text: "Member", exact: false })).toBe(
      true
    )
  })
})

describe("buildPlan", () => {
  it("ranks role+name first, then anchors, then fallbacks", () => {
    const plan = buildPlan(
      descriptor({
        role: "textbox",
        name: { text: "Member Number", exact: true },
        anchors: [
          {
            relation: "rightOf",
            role: "cell",
            match: { text: "Member Number", exact: true },
          },
        ],
        fallbacks: [
          { _tag: "controlName", name: "f1_ctl03" },
          { _tag: "css", selector: "#x" },
        ],
      })
    )

    expect(plan.map((entry) => `${entry.rank}:${entry.kind}`)).toEqual([
      "0:roleAndName",
      "1:anchor",
      "2:fallback",
      "3:fallback",
    ])
  })

  it("omits role+name when there is no name, because a bare role is a filter", () => {
    const plan = buildPlan(
      descriptor({
        role: "textbox",
        anchors: [{ relation: "within", match: { text: "x", exact: true } }],
      })
    )

    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ rank: 0, kind: "anchor" })
  })
})

describe("resolving by role and name", () => {
  it("finds a button that has an accessible name", () => {
    const result = resolveInObservation(
      observe(searchFrame),
      descriptor({ role: "button", name: { text: "Search", exact: true } })
    )

    expect(result._tag).toBe("resolved")
    if (result._tag !== "resolved") return
    expect(result.resolution.rank).toBe(0)
    expect(result.resolution.strategy._tag).toBe("roleAndName")
    expect(result.frame).toEqual(["contentFrame"])
  })
})

describe("resolving a control with no accessible name", () => {
  /**
   * The case the whole anchor mechanism exists for. Role alone matches the
   * textbox, but in a real page there are several; the label in the neighbouring
   * cell is the only thing that identifies this one.
   */
  it("finds the textbox in the cell right of its label", () => {
    const result = resolveInObservation(
      observe(searchFrame),
      descriptor({
        role: "textbox",
        anchors: [
          {
            relation: "rightOf",
            role: "cell",
            match: { text: "Member Number", exact: true },
          },
        ],
      })
    )

    expect(result._tag).toBe("resolved")
    if (result._tag !== "resolved") return
    expect(result.node.role).toBe("textbox")
    expect(result.node.name).toBe("")
  })

  it("reports the anchor rank, so a demoted primary is visible as drift", () => {
    // Role+name is tried first and fails: no textbox is named "Member Number".
    const result = resolveInObservation(
      observe(searchFrame),
      descriptor({
        role: "textbox",
        name: { text: "Member Number", exact: true },
        anchors: [
          {
            relation: "rightOf",
            role: "cell",
            match: { text: "Member Number", exact: true },
          },
        ],
      })
    )

    expect(result._tag).toBe("resolved")
    if (result._tag !== "resolved") return
    // Rank 1, not 0 — the signal that this step no longer resolves the way it was recorded.
    expect(result.resolution.rank).toBe(1)
    expect(result.resolution.strategy).toEqual({ _tag: "anchor", index: 0 })
  })

  it("does not match a label cell that only contains the text", () => {
    const result = resolveInObservation(
      observe(searchFrame),
      descriptor({
        role: "textbox",
        anchors: [
          {
            relation: "leftOf",
            role: "cell",
            match: { text: "Member Number", exact: true },
          },
        ],
      })
    )

    expect(result._tag).toBe("exhausted")
  })
})

describe("ambiguity", () => {
  /** After a sub-account is opened the real page really does have two of these. */
  const accountsFrame = frame(["contentFrame"], {
    role: "table",
    children: [
      {
        role: "row",
        children: [
          { role: "cell", name: "Savings" },
          { role: "cell", name: "$4,812.65" },
        ],
      },
      {
        role: "row",
        children: [
          { role: "cell", name: "Savings" },
          { role: "cell", name: "$150.00" },
        ],
      },
    ],
  })

  it("refuses to guess when two controls match", () => {
    const result = resolveInObservation(
      observe(accountsFrame),
      descriptor({
        role: "cell",
        anchors: [
          {
            relation: "rightOf",
            role: "cell",
            match: { text: "Savings", exact: true },
          },
        ],
      })
    )

    expect(result._tag).toBe("ambiguous")
    if (result._tag !== "ambiguous") return
    expect(result.matchCount).toBe(2)
  })

  it("resolves when the artifact declares which one it meant", () => {
    const result = resolveInObservation(
      observe(accountsFrame),
      descriptor({
        role: "cell",
        nth: 0,
        anchors: [
          {
            relation: "rightOf",
            role: "cell",
            match: { text: "Savings", exact: true },
          },
        ],
      })
    )

    expect(result._tag).toBe("resolved")
    if (result._tag !== "resolved") return
    expect(result.node.name).toBe("$4,812.65")
  })
})

describe("frames", () => {
  it("treats an unscoped descriptor as spanning every frame", () => {
    const result = resolveInObservation(
      observe(searchFrame, navFrame),
      descriptor({ role: "link", name: { text: "Member Search", exact: true } })
    )

    expect(result._tag).toBe("resolved")
    if (result._tag !== "resolved") return
    expect(result.frame).toEqual(["navFrame"])
  })

  it("catches a name that is only ambiguous once you look at the whole page", () => {
    const duplicate = frame(
      ["otherFrame"],
      { role: "list", children: [{ role: "link", name: "Member Search" }] },
      "d"
    )

    const result = resolveInObservation(
      observe(navFrame, duplicate),
      descriptor({ role: "link", name: { text: "Member Search", exact: true } })
    )

    expect(result._tag).toBe("ambiguous")
  })

  it("scopes to one document when the descriptor names a frame", () => {
    const duplicate = frame(
      ["otherFrame"],
      { role: "list", children: [{ role: "link", name: "Member Search" }] },
      "d"
    )

    const result = resolveInObservation(
      observe(navFrame, duplicate),
      descriptor({
        frame: ["navFrame"],
        role: "link",
        name: { text: "Member Search", exact: true },
      })
    )

    expect(result._tag).toBe("resolved")
    if (result._tag !== "resolved") return
    expect(result.frame).toEqual(["navFrame"])
  })
})

describe("vertical relations", () => {
  const grid = frame(["contentFrame"], {
    role: "table",
    children: [
      {
        role: "row",
        children: [
          { role: "cell", name: "Account Type" },
          { role: "cell", name: "Current Balance" },
        ],
      },
      {
        role: "row",
        children: [
          { role: "cell", name: "Savings" },
          { role: "cell", name: "$4,812.65" },
        ],
      },
    ],
  })

  it("finds the cell below a column header", () => {
    const result = resolveInObservation(
      observe(grid),
      descriptor({
        role: "cell",
        anchors: [
          {
            relation: "below",
            role: "cell",
            match: { text: "Current Balance", exact: true },
          },
        ],
      })
    )

    expect(result._tag).toBe("resolved")
    if (result._tag !== "resolved") return
    expect(result.node.name).toBe("$4,812.65")
  })
})

describe("exhaustion", () => {
  it("leaves markup fallbacks to the adapter rather than failing outright", () => {
    const result = resolveInObservation(
      observe(searchFrame),
      descriptor({
        role: "button",
        name: { text: "Nothing Like This", exact: true },
        fallbacks: [{ _tag: "css", selector: "input[name=f1_ctl09]" }],
      })
    )

    expect(result._tag).toBe("exhausted")
    if (result._tag !== "exhausted") return
    // Only the accessibility strategy was consumed; rank 1 is still the adapter's to try.
    expect(result.ranksTried).toBe(1)
  })
})
