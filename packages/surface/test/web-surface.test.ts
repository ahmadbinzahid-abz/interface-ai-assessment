import { TargetDescriptor } from "@workspace/contracts"
import { Effect, Exit } from "effect"
import { chromium, type Browser, type Page } from "playwright"
import { startCoreBank, type CoreBankTestServer } from "target-corebank/testing"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { ControlLease } from "../src/control.js"
import { makeWebSurface } from "../src/playwright/web-surface.js"
import type { Actor, Surface } from "../src/types.js"

/**
 * The adapter driving the real stand-in in a real browser.
 *
 * The resolver's own tests run against captured trees and cover the logic; this
 * covers the things only a browser can prove — that the per-frame accessibility
 * read actually returns the frameset's controls, that an accessibility node can
 * be acted on, and that the control lease really refuses.
 */

let corebank: CoreBankTestServer
let browser: Browser
let page: Page
let baseUrl: string

const automation: Actor = { _tag: "automation", runId: "run-test" }
const operator: Actor = { _tag: "operator", operatorId: "op-1" }

let lease: ControlLease
let surface: Surface

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect)

const descriptor = (
  fields: Partial<ConstructorParameters<typeof TargetDescriptor>[0]>
) =>
  new TargetDescriptor({
    description: "target",
    frame: [],
    anchors: [],
    fallbacks: [],
    ...fields,
  })

/** The unnamed member-id field, findable only by its label's position. */
const memberIdField = descriptor({
  description: "Member number field on the search form",
  frame: ["contentFrame"],
  role: "textbox",
  anchors: [
    {
      relation: "rightOf",
      role: "cell",
      match: { text: "Member Number", exact: true },
    },
  ],
  fallbacks: [{ _tag: "controlName", name: "f1_ctl03" }],
})

const searchButton = descriptor({
  description: "Search button",
  frame: ["contentFrame"],
  role: "button",
  name: { text: "Search", exact: true },
})

beforeAll(async () => {
  corebank = await startCoreBank()
  baseUrl = corebank.baseUrl

  browser = await chromium.launch()
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await corebank.stop()
})

beforeEach(async () => {
  corebank.reset()

  page = await browser.newPage()
  lease = new ControlLease()
  lease.grantTo({ _tag: "automation", runId: "run-test" })
  surface = await run(makeWebSurface({ page, lease }))

  // Sign on through the surface itself, which also exercises navigate + type + click.
  await run(
    surface.act(automation, {
      _tag: "navigate",
      url: `${baseUrl}/firstcity/login`,
    })
  )

  const operatorId = await run(
    surface.resolve(
      descriptor({
        description: "Operator ID",
        role: "textbox",
        anchors: [
          {
            relation: "rightOf",
            role: "cell",
            match: { text: "Operator ID", exact: true },
          },
        ],
      })
    )
  )
  await run(
    surface.act(automation, {
      _tag: "type",
      handle: operatorId.handle,
      text: "teller01",
      clearFirst: true,
    })
  )

  const password = await run(
    surface.resolve(
      descriptor({
        description: "Password",
        role: "textbox",
        anchors: [
          {
            relation: "rightOf",
            role: "cell",
            match: { text: "Password", exact: true },
          },
        ],
        fallbacks: [{ _tag: "controlName", name: "f1_ctl02" }],
      })
    )
  )
  await run(
    surface.act(automation, {
      _tag: "type",
      handle: password.handle,
      text: "demo-pass",
      clearFirst: true,
    })
  )

  const signOn = await run(
    surface.resolve(
      descriptor({
        description: "Sign On",
        role: "button",
        name: { text: "Sign On", exact: true },
      })
    )
  )
  await run(surface.act(automation, { _tag: "click", handle: signOn.handle }))
  await page.waitForURL(/desk/)
  await page.waitForFunction(() => window.frames.length > 0, null, {
    timeout: 10_000,
  })
}, 60_000)

describe("observing a frameset", () => {
  it("reads every frame, not just the top document", async () => {
    const observation = await run(surface.observe())
    const paths = observation.frames.map((frame) => frame.path.join("/"))

    expect(paths).toContain("")
    expect(paths).toContain("navFrame")
    expect(paths).toContain("contentFrame")
  })

  it("finds the controls, which a page-level read would miss entirely", async () => {
    const observation = await run(surface.observe())
    const content = observation.frames.find(
      (frame) => frame.path[0] === "contentFrame"
    )

    const roles = content?.nodes.map((node) => node.role) ?? []
    expect(roles).toContain("textbox")
    expect(roles).toContain("button")
  })

  it("reports the member field as genuinely nameless", async () => {
    const observation = await run(surface.observe())
    const content = observation.frames.find(
      (frame) => frame.path[0] === "contentFrame"
    )
    const textbox = content?.nodes.find((node) => node.role === "textbox")

    expect(textbox?.name).toBe("")
  })
})

describe("resolving", () => {
  it("finds a named button by role and name at rank 0", async () => {
    const resolved = await run(surface.resolve(searchButton))

    expect(resolved.resolution.rank).toBe(0)
    expect(resolved.resolution.strategy._tag).toBe("roleAndName")
    expect(resolved.handle._tag).toBe("node")
  })

  it("finds the nameless field through its label's position", async () => {
    const resolved = await run(surface.resolve(memberIdField))

    expect(resolved.handle._tag).toBe("node")
    expect(resolved.resolution.strategy).toEqual({ _tag: "anchor", index: 0 })
  })

  it("falls back to the legacy control name, and says that it did", async () => {
    const resolved = await run(
      surface.resolve(
        descriptor({
          description: "Member field, but described wrongly on purpose",
          frame: ["contentFrame"],
          role: "textbox",
          anchors: [
            {
              relation: "rightOf",
              role: "cell",
              match: { text: "Nothing Here", exact: true },
            },
          ],
          fallbacks: [{ _tag: "controlName", name: "f1_ctl03" }],
        })
      )
    )

    expect(resolved.handle._tag).toBe("query")
    // Rank 1: the anchor was tried and lost. In production this is the drift alarm.
    expect(resolved.resolution.rank).toBe(1)
  })

  it("fails rather than guessing when nothing matches", async () => {
    const exit = await Effect.runPromiseExit(
      surface.resolve(
        descriptor({
          description: "No such control",
          role: "button",
          name: { text: "Definitely Not Here", exact: true },
        })
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("acting", () => {
  it("types into an accessibility-resolved control and submits the form", async () => {
    const field = await run(surface.resolve(memberIdField))
    await run(
      surface.act(automation, {
        _tag: "type",
        handle: field.handle,
        text: "12345",
        clearFirst: true,
      })
    )

    const button = await run(surface.resolve(searchButton))
    await run(surface.act(automation, { _tag: "click", handle: button.handle }))

    await page.waitForFunction(
      () =>
        Array.from(window.frames).some((f) =>
          f.location.href.includes("/member/12345")
        ),
      null,
      { timeout: 10_000 }
    )

    const observation = await run(surface.observe())
    const content = observation.frames.find(
      (frame) => frame.path[0] === "contentFrame"
    )
    expect(content?.url).toContain("/member/12345")
  })

  it("reads the balance the capability is supposed to extract", async () => {
    const field = await run(surface.resolve(memberIdField))
    await run(
      surface.act(automation, {
        _tag: "type",
        handle: field.handle,
        text: "12345",
        clearFirst: true,
      })
    )
    const button = await run(surface.resolve(searchButton))
    await run(surface.act(automation, { _tag: "click", handle: button.handle }))
    await page.waitForFunction(
      () =>
        Array.from(window.frames).some((f) =>
          f.location.href.includes("/member/12345")
        ),
      null,
      { timeout: 10_000 }
    )

    const balance = await run(
      surface.resolve(
        descriptor({
          description: "Savings balance cell",
          frame: ["contentFrame"],
          role: "cell",
          anchors: [
            {
              relation: "rightOf",
              role: "cell",
              match: { text: "S-0001-12345", exact: true },
            },
          ],
          nth: 1,
        })
      )
    )

    const text = await run(surface.read(balance.handle))
    expect(text).toContain("4,812.65")
  })

  it("leaves no trace of the targeting attribute on the page", async () => {
    const field = await run(surface.resolve(memberIdField))
    await run(
      surface.act(automation, {
        _tag: "type",
        handle: field.handle,
        text: "12345",
        clearFirst: true,
      })
    )

    const content = page.frame({ name: "contentFrame" })
    const leftovers = await content?.locator("[data-cua-target]").count()
    expect(leftovers).toBe(0)
  })
})

describe("the control lease", () => {
  it("refuses an actor that does not hold the session", async () => {
    const button = await run(surface.resolve(searchButton))

    const exit = await Effect.runPromiseExit(
      surface.act(operator, { _tag: "click", handle: button.handle })
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("refuses the automation once an operator has taken over", async () => {
    lease.grantTo({ _tag: "operator", operatorId: "op-1" })

    const button = await run(surface.resolve(searchButton))
    const denied = await Effect.runPromiseExit(
      surface.act(automation, { _tag: "click", handle: button.handle })
    )
    expect(Exit.isFailure(denied)).toBe(true)

    // The operator drives the same live session, and observation keeps working
    // throughout — that is how the handoff gets recorded.
    const allowed = await Effect.runPromiseExit(
      surface.act(operator, { _tag: "click", handle: button.handle })
    )
    expect(Exit.isSuccess(allowed)).toBe(true)

    const observation = await run(surface.observe())
    expect(observation.frames.length).toBeGreaterThan(1)
  })

  it("still allows reading while someone else drives", async () => {
    const button = await run(surface.resolve(searchButton))
    lease.grantTo({ _tag: "operator", operatorId: "op-1" })

    const text = await run(surface.read(button.handle))
    expect(text.length).toBeGreaterThanOrEqual(0)
  })
})
