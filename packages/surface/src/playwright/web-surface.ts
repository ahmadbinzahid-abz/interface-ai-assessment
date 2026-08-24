import { randomUUID } from "node:crypto"

import type {
  Observation,
  OperatorInput,
  TargetDescriptor,
} from "@workspace/contracts"
import { Effect } from "effect"
import type { CDPSession, Frame, Locator, Page } from "playwright"

import { ControlLease, describeActor, describeHolder } from "../control.js"
import {
  AmbiguousTarget,
  ControlDenied,
  InteractionFailed,
  NavigationFailed,
  SurfaceUnavailable,
  TargetNotFound,
  type SurfaceError,
  type TargetResolutionError,
} from "../errors.js"
import { buildPlan, resolveInObservation } from "../resolve.js"
import type {
  PointDescription,
  Screencast,
  ScreencastFrame,
  ScreencastOptions,
  TakeoverSurface,
} from "../takeover.js"
import type {
  Actor,
  ElementDetail,
  ResolvedTarget,
  Surface,
  SurfaceCommand,
  TargetHandle,
} from "../types.js"
import { readObservation } from "./ax.js"

/**
 * The web adapter.
 *
 * The division of labour is the point. The **accessibility tree decides which
 * control** — that reasoning is pure, portable, and shared with any future
 * desktop adapter. The adapter only decides **how to touch it**, which is
 * necessarily browser-specific. Everything Playwright-shaped is confined to this
 * directory; nothing above it knows a browser exists.
 */

/**
 * Bridging an accessibility node to something Playwright can act on.
 *
 * Playwright has no public way to adopt a CDP `backendNodeId`, so the element is
 * tagged with a one-shot attribute over CDP and then located normally. The
 * alternative — computing a bounding box and clicking coordinates — is more
 * faithful to "computer use" but gives up Playwright's actionability checks
 * (visibility, stability, hit-testing), which are exactly what keeps replay from
 * being flaky. The attribute is removed immediately afterwards.
 */
const TARGET_ATTRIBUTE = "data-cua-target"

/**
 * Keys whose meaning Chromium takes from the virtual key code rather than from
 * the text, so a bare `text` never produces them.
 *
 * Small on purpose. This is not a keyboard layout table — it is the handful of
 * keys that actually drive a form in this class of application, and anything
 * outside it still works as text.
 */
const VIRTUAL_KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
}

/** Text a key produces when it produces any. Non-printable keys produce none. */
const textFor = (key: string, declared?: string): string | undefined =>
  declared ?? (key.length === 1 ? key : key === "Enter" ? "\r" : undefined)

const dispatchInput = async (
  cdp: CDPSession,
  event: OperatorInput
): Promise<void> => {
  switch (event._tag) {
    case "mouseMoved":
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: event.x,
        y: event.y,
        button: "none",
      })
      return

    case "mousePressed":
    case "mouseReleased":
      await cdp.send("Input.dispatchMouseEvent", {
        type: event._tag,
        x: event.x,
        y: event.y,
        button: event.button,
        clickCount: event.clickCount,
        // Chromium ignores a press with no buttons mask, which is the failure
        // mode that looks like "the click did nothing".
        buttons: event._tag === "mousePressed" ? 1 : 0,
      })
      return

    case "mouseWheel":
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: event.x,
        y: event.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
      })
      return

    case "keyDown": {
      const text = textFor(event.key, event.text)
      await cdp.send("Input.dispatchKeyEvent", {
        // `keyDown` carries text and produces a character; `rawKeyDown` is what
        // a non-printable key needs, and sending the wrong one is why arrow keys
        // silently do nothing.
        type: text === undefined ? "rawKeyDown" : "keyDown",
        key: event.key,
        code: event.code,
        text,
        unmodifiedText: text,
        windowsVirtualKeyCode: VIRTUAL_KEY_CODES[event.key],
        nativeVirtualKeyCode: VIRTUAL_KEY_CODES[event.key],
        modifiers: event.modifiers,
      })
      return
    }

    case "keyUp":
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: event.key,
        code: event.code,
        windowsVirtualKeyCode: VIRTUAL_KEY_CODES[event.key],
        nativeVirtualKeyCode: VIRTUAL_KEY_CODES[event.key],
        modifiers: event.modifiers,
      })
      return

    case "insertText":
      await cdp.send("Input.insertText", { text: event.text })
      return
  }
}

/** The web surface can be co-browsed, so it satisfies both halves. */
export type WebSurface = Surface & TakeoverSurface

export interface WebSurfaceOptions {
  readonly page: Page
  readonly lease: ControlLease
  readonly defaultTimeoutMs?: number
}

export const makeWebSurface = ({
  page,
  lease,
  defaultTimeoutMs = 10_000,
}: WebSurfaceOptions): Effect.Effect<WebSurface, SurfaceUnavailable> =>
  Effect.gen(function* () {
    const cdp: CDPSession = yield* Effect.tryPromise({
      try: async () => {
        const session = await page.context().newCDPSession(page)
        await session.send("Accessibility.enable")
        await session.send("DOM.enable")
        // Screencast frames are Page-domain events, and they arrive nowhere at
        // all if the domain was never enabled.
        await session.send("Page.enable")
        return session
      },
      catch: (cause) =>
        new SurfaceUnavailable({
          detail: `could not attach CDP: ${String(cause)}`,
        }),
    })

    /**
     * The status of the most recent document response.
     *
     * These applications carry meaning in the status line that is invisible in
     * the page text — the stand-in returns 404 for "no such member", 403 for a
     * permission denial and 422 for a rejected form — so an artifact can detect
     * an outcome by status instead of by matching a message that a tenant may
     * have reworded. Document responses only: an image 404 is not the page.
     *
     * The last one wins, which for a frameset is the frame that actually
     * navigated, and that is the one carrying the answer.
     */
    let lastDocumentStatus: number | undefined
    page.on("response", (response) => {
      if (response.request().resourceType() === "document") {
        lastDocumentStatus = response.status()
      }
    })

    // ── Frames ───────────────────────────────────────────────────────────

    const findFrame = (path: readonly string[]): Frame | undefined => {
      let current: Frame = page.mainFrame()

      for (const name of path) {
        const next = current
          .childFrames()
          .find((frame) => frame.name() === name)
        if (!next) return undefined
        current = next
      }

      return current
    }

    const framesFor = (path: readonly string[]): readonly Frame[] => {
      if (path.length > 0) {
        const frame = findFrame(path)
        return frame ? [frame] : []
      }

      // No declared frame means the descriptor does not care which document the
      // control is in, so uniqueness has to hold across all of them.
      const all: Frame[] = []
      const walk = (frame: Frame) => {
        all.push(frame)
        frame.childFrames().forEach(walk)
      }
      walk(page.mainFrame())
      return all
    }

    // ── Handles ──────────────────────────────────────────────────────────

    const locatorFor = async (
      handle: TargetHandle
    ): Promise<{
      locator: Locator
      release: () => Promise<void>
    }> => {
      if (handle._tag === "point") {
        throw new Error("a point handle has no element to locate")
      }

      const frame = findFrame(handle.frame)
      if (!frame) throw new Error(`frame [${handle.frame.join(" > ")}] is gone`)

      if (handle._tag === "query") {
        const locator =
          handle.kind === "xpath"
            ? frame.locator(`xpath=${handle.expression}`)
            : frame.locator(handle.expression)
        return { locator, release: async () => {} }
      }

      const token = randomUUID()
      const { object } = await cdp.send("DOM.resolveNode", {
        backendNodeId: handle.platformHandle,
      })

      if (!object.objectId)
        throw new Error("accessibility node no longer has a DOM element")
      const objectId = object.objectId

      await cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function (attribute, token) { this.setAttribute(attribute, token); }`,
        arguments: [{ value: TARGET_ATTRIBUTE }, { value: token }],
      })

      return {
        locator: frame.locator(`[${TARGET_ATTRIBUTE}="${token}"]`),
        release: async () => {
          await cdp
            .send("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: `function (attribute) { this.removeAttribute(attribute); }`,
              arguments: [{ value: TARGET_ATTRIBUTE }],
            })
            .catch(() => undefined)
        },
      }
    }

    const withElement = async <A>(
      handle: TargetHandle,
      use: (locator: Locator) => Promise<A>
    ): Promise<A> => {
      const { locator, release } = await locatorFor(handle)
      try {
        return await use(locator)
      } finally {
        await release()
      }
    }

    // ── Observe ──────────────────────────────────────────────────────────

    const observe = (): Effect.Effect<Observation, SurfaceError> =>
      Effect.tryPromise({
        try: () => readObservation(page, cdp, lastDocumentStatus),
        catch: (cause) => new SurfaceUnavailable({ detail: String(cause) }),
      })

    // ── Resolve ──────────────────────────────────────────────────────────

    /**
     * Markup fallbacks, tried only once every accessibility strategy has failed.
     * Ranks continue from the shared plan, so a rank means the same thing whether
     * the accessibility half or this half produced it.
     */
    const resolveByFallbacks = (
      descriptor: TargetDescriptor
    ): Effect.Effect<ResolvedTarget | undefined, SurfaceError> =>
      Effect.tryPromise({
        try: async (): Promise<ResolvedTarget | undefined> => {
          for (const entry of buildPlan(descriptor)) {
            if (entry.kind !== "fallback") continue

            const strategy = entry.strategy

            if (strategy._tag === "point") {
              // Coordinates cannot be checked for uniqueness — there is nothing to
              // count. That is precisely why they rank last.
              return {
                handle: { _tag: "point", x: strategy.x, y: strategy.y },
                resolution: {
                  strategy: {
                    _tag: "fallback",
                    index: entry.index,
                    kind: "point",
                  },
                  rank: entry.rank,
                  matchCount: 1,
                },
              }
            }

            const [kind, expression] =
              strategy._tag === "controlName"
                ? (["css", `[name="${strategy.name}"]`] as const)
                : strategy._tag === "css"
                  ? (["css", strategy.selector] as const)
                  : (["xpath", strategy.expression] as const)

            for (const frame of framesFor(descriptor.frame)) {
              const locator =
                kind === "xpath"
                  ? frame.locator(`xpath=${expression}`)
                  : frame.locator(expression)

              const matchCount = await locator.count()
              if (matchCount === 0) continue

              const index = matchCount === 1 ? 0 : descriptor.nth
              if (index === undefined) {
                throw new AmbiguousTarget({
                  description: descriptor.description,
                  matchCount,
                  atRank: entry.rank,
                })
              }

              return {
                handle: {
                  _tag: "query",
                  frame: descriptor.frame,
                  kind,
                  // Pin the chosen match so acting cannot pick a different one.
                  expression:
                    kind === "xpath"
                      ? `(${expression})[${index + 1}]`
                      : `${expression} >> nth=${index}`,
                },
                resolution: {
                  strategy: {
                    _tag: "fallback",
                    index: entry.index,
                    kind: strategy._tag,
                  },
                  rank: entry.rank,
                  matchCount,
                },
              }
            }
          }

          return undefined
        },
        catch: (cause) =>
          cause instanceof AmbiguousTarget
            ? cause
            : new SurfaceUnavailable({ detail: String(cause) }),
      }) as Effect.Effect<ResolvedTarget | undefined, SurfaceError>

    const resolve = (
      descriptor: TargetDescriptor
    ): Effect.Effect<ResolvedTarget, TargetResolutionError | SurfaceError> =>
      Effect.gen(function* () {
        const observation = yield* observe()
        const found = resolveInObservation(observation, descriptor)

        if (found._tag === "ambiguous") {
          return yield* new AmbiguousTarget({
            description: descriptor.description,
            matchCount: found.matchCount,
            atRank: found.rank,
          })
        }

        if (found._tag === "resolved") {
          if (found.node.handle === undefined) {
            // An accessibility node with no DOM element behind it cannot be acted
            // on; fall through to the markup fallbacks rather than pretend.
            const fallback = yield* resolveByFallbacks(descriptor)
            if (fallback) return fallback

            return yield* new TargetNotFound({
              description: descriptor.description,
              strategiesTried: buildPlan(descriptor).length,
            })
          }

          return {
            handle: {
              _tag: "node",
              frame: found.frame,
              nodeId: found.node.id,
              platformHandle: found.node.handle,
            },
            resolution: found.resolution,
          }
        }

        const fallback = yield* resolveByFallbacks(descriptor)
        if (fallback) return fallback

        return yield* new TargetNotFound({
          description: descriptor.description,
          strategiesTried: buildPlan(descriptor).length,
        })
      })

    // ── Act ──────────────────────────────────────────────────────────────

    const perform = (command: SurfaceCommand): Promise<void> => {
      switch (command._tag) {
        case "navigate":
          return page
            .goto(command.url, { timeout: defaultTimeoutMs, waitUntil: "load" })
            .then(() => undefined)

        case "press":
          return page.keyboard.press(command.key)

        case "click":
          if (command.handle._tag === "point") {
            return page.mouse.click(command.handle.x, command.handle.y)
          }
          return withElement(command.handle, (locator) =>
            locator.click({ timeout: defaultTimeoutMs })
          )

        case "type":
          if (command.handle._tag === "point") {
            return page.mouse
              .click(command.handle.x, command.handle.y)
              .then(() => page.keyboard.type(command.text))
          }
          return withElement(command.handle, async (locator) => {
            if (command.clearFirst)
              await locator.fill("", { timeout: defaultTimeoutMs })
            // `fill` rather than `type`: these are form fields, and per-key input
            // buys nothing but flakiness on a server-rendered page.
            await locator.fill(command.text, { timeout: defaultTimeoutMs })
          })

        case "select":
          if (command.handle._tag === "point") {
            return Promise.reject(
              new Error("cannot select on a coordinate handle")
            )
          }
          return withElement(command.handle, (locator) =>
            locator
              .selectOption(command.value, { timeout: defaultTimeoutMs })
              .then(() => undefined)
          )
      }
    }

    const act = (
      actor: Actor,
      command: SurfaceCommand
    ): Effect.Effect<void, SurfaceError> =>
      Effect.gen(function* () {
        // The chokepoint. While an operator holds the session, automation is
        // refused rather than merely discouraged.
        if (!lease.permits(actor)) {
          return yield* new ControlDenied({
            actor: describeActor(actor),
            holder: describeHolder(lease.current()),
          })
        }

        return yield* Effect.tryPromise({
          try: () => perform(command),
          catch: (cause) =>
            command._tag === "navigate"
              ? new NavigationFailed({
                  url: command.url,
                  detail: String(cause),
                })
              : new InteractionFailed({
                  command: command._tag,
                  detail: String(cause),
                }),
        })
      })

    /**
     * Read what a control currently holds.
     *
     * Form controls carry their content in the `value` *property*, not in text
     * content — `innerText` on an `<input>` is always empty. Getting this wrong
     * makes every "did the field actually take what we typed?" checkpoint fail,
     * which is how this was found.
     */
    const read = (handle: TargetHandle): Effect.Effect<string, SurfaceError> =>
      Effect.tryPromise({
        try: () =>
          handle._tag === "point"
            ? Promise.reject(
                new Error("cannot read text from a coordinate handle")
              )
            : withElement(handle, (locator) =>
                locator.evaluate((element) =>
                  element instanceof HTMLInputElement ||
                  element instanceof HTMLTextAreaElement ||
                  element instanceof HTMLSelectElement
                    ? element.value
                    : ((element as HTMLElement).innerText ??
                      element.textContent ??
                      "")
                )
              ),
        catch: (cause) =>
          new InteractionFailed({ command: "read", detail: String(cause) }),
      })

    /**
     * Attributes and geometry for a resolved control, read once at record time.
     *
     * Both feed the ranked fallbacks: the legacy `name` attribute becomes the
     * `controlName` strategy, and the box centre becomes the coordinate strategy
     * of last resort.
     */
    const describe = (
      handle: TargetHandle
    ): Effect.Effect<ElementDetail, SurfaceError> =>
      Effect.tryPromise({
        try: async (): Promise<ElementDetail> => {
          const viewport = page.viewportSize() ?? undefined

          if (handle._tag === "point") {
            return { attributes: {}, viewport }
          }

          if (handle._tag === "node") {
            const { node } = await cdp.send("DOM.describeNode", {
              backendNodeId: handle.platformHandle,
            })

            // CDP returns attributes as a flat [name, value, name, value] array.
            const flat = node.attributes ?? []
            const attributes: Record<string, string> = {}
            for (let i = 0; i + 1 < flat.length; i += 2) {
              const key = flat[i]
              const value = flat[i + 1]
              if (key !== undefined && value !== undefined)
                attributes[key] = value
            }

            let bounds: ElementDetail["bounds"]
            try {
              const { model } = await cdp.send("DOM.getBoxModel", {
                backendNodeId: handle.platformHandle,
              })
              // `content` is a quad: x1,y1,x2,y2,x3,y3,x4,y4.
              const [x1, y1, x2, , , y3] = model.content
              if (
                x1 !== undefined &&
                y1 !== undefined &&
                x2 !== undefined &&
                y3 !== undefined
              ) {
                bounds = { x: x1, y: y1, width: x2 - x1, height: y3 - y1 }
              }
            } catch {
              // An element that is not rendered has no box. Not fatal — it just
              // means no coordinate fallback gets recorded for this step.
            }

            return { attributes, bounds, viewport }
          }

          return withElement(handle, async (locator) => {
            const attributes = await locator.evaluate((element) =>
              Object.fromEntries(
                Array.from((element as Element).attributes).map((attribute) => [
                  attribute.name,
                  attribute.value,
                ])
              )
            )
            const box = await locator.boundingBox()

            return {
              attributes: attributes as Record<string, string>,
              bounds: box ?? undefined,
              viewport,
            }
          })
        },
        catch: (cause) =>
          new InteractionFailed({ command: "describe", detail: String(cause) }),
      })

    const screenshot = (): Effect.Effect<Uint8Array, SurfaceError> =>
      Effect.tryPromise({
        try: async () => new Uint8Array(await page.screenshot({ type: "png" })),
        catch: (cause) => new SurfaceUnavailable({ detail: String(cause) }),
      })

    // ── Live takeover ────────────────────────────────────────────────────

    /**
     * Carry the live page out to an operator, frame by frame.
     *
     * CDP delivers a frame on paint and then *waits for an ack* before sending
     * another, which is why the ack is unconditional and fire-and-forget: a
     * consumer that failed to render must not be able to stall the screencast,
     * and a stalled screencast during a takeover looks exactly like a frozen
     * application.
     *
     * The frame's own device size travels with it. Input coordinates come back
     * in that space, so the console never has to guess how its `<img>` was
     * scaled, and there is one conversion in the system rather than two.
     */
    const startScreencast = (
      onFrame: (frame: ScreencastFrame) => void,
      options: ScreencastOptions = {}
    ): Effect.Effect<Screencast, SurfaceError> =>
      Effect.tryPromise({
        try: async (): Promise<Screencast> => {
          const listener = (payload: {
            data: string
            sessionId: number
            metadata: { deviceWidth?: number; deviceHeight?: number }
          }) => {
            const viewport = page.viewportSize()

            onFrame({
              data: payload.data,
              width: payload.metadata.deviceWidth ?? viewport?.width ?? 0,
              height: payload.metadata.deviceHeight ?? viewport?.height ?? 0,
              at: new Date().toISOString(),
            })

            void cdp
              .send("Page.screencastFrameAck", { sessionId: payload.sessionId })
              .catch(() => undefined)
          }

          cdp.on("Page.screencastFrame", listener)

          await cdp.send("Page.startScreencast", {
            format: "jpeg",
            quality: options.quality ?? 60,
            maxWidth: options.maxWidth,
            maxHeight: options.maxHeight,
            everyNthFrame: options.everyNthFrame ?? 1,
          })

          return {
            stop: () =>
              Effect.promise(async () => {
                cdp.off("Page.screencastFrame", listener)
                await cdp.send("Page.stopScreencast").catch(() => undefined)
              }),
          }
        },
        catch: (cause) => new SurfaceUnavailable({ detail: String(cause) }),
      })

    /**
     * The operator's half of the co-browsing channel.
     *
     * Raw CDP input rather than Playwright's `page.mouse` on purpose: the point
     * of a takeover is that the person can do things this system has no model
     * of, so anything that first asks "which element is this?" would fail
     * exactly on the screens takeovers exist for.
     *
     * It still goes through the lease. An open socket is not permission to act —
     * only holding the session is, and the run reclaiming control revokes it
     * mid-stream without the socket having to notice.
     */
    const dispatch = (
      actor: Actor,
      event: OperatorInput
    ): Effect.Effect<void, SurfaceError> =>
      Effect.gen(function* () {
        if (!lease.permits(actor)) {
          return yield* new ControlDenied({
            actor: describeActor(actor),
            holder: describeHolder(lease.current()),
          })
        }

        return yield* Effect.tryPromise({
          try: () => dispatchInput(cdp, event),
          catch: (cause) =>
            new InteractionFailed({
              command: event._tag,
              detail: String(cause),
            }),
        })
      })

    /**
     * What the operator just touched, in accessibility terms.
     *
     * This is what keeps an operator action log promotable. A click is captured
     * as a coordinate because that is what happened, and *also* as a role and a
     * name because that is the only form a capability step can be written in.
     * Without this half, "the operator's fix can become a new artifact version"
     * would be a slogan.
     */
    const describeAt = (
      x: number,
      y: number
    ): Effect.Effect<PointDescription, SurfaceError> =>
      Effect.tryPromise({
        try: async (): Promise<PointDescription> => {
          const located = await cdp
            .send("DOM.getNodeForLocation", {
              x: Math.round(x),
              y: Math.round(y),
              includeUserAgentShadowDOM: false,
            })
            .catch(() => undefined)

          if (!located?.backendNodeId) return { frame: [] }

          const frame = await framePathOf(located.frameId)

          const partial = await cdp
            .send("Accessibility.getPartialAXTree", {
              backendNodeId: located.backendNodeId,
              fetchRelatives: false,
            })
            .catch(() => undefined)

          const node = partial?.nodes?.[0]
          const text = (value: { value?: unknown } | undefined) =>
            typeof value?.value === "string" ? value.value : undefined

          return {
            role: text(node?.role),
            name: text(node?.name),
            value: text(node?.value),
            frame,
          }
        },
        catch: (cause) =>
          new InteractionFailed({ command: "describeAt", detail: String(cause) }),
      })

    /** Frame id → the name path the rest of the system addresses frames by. */
    const framePathOf = async (
      frameId: string | undefined
    ): Promise<readonly string[]> => {
      if (!frameId) return []

      const { frameTree } = await cdp.send("Page.getFrameTree")

      const walk = (
        node: {
          frame: { id: string; name?: string }
          childFrames?: unknown[]
        },
        path: readonly string[],
        isRoot: boolean
      ): readonly string[] | undefined => {
        const here = isRoot
          ? []
          : [...path, node.frame.name || node.frame.id]

        if (node.frame.id === frameId) return here

        for (const child of (node.childFrames ?? []) as Parameters<
          typeof walk
        >[0][]) {
          const found = walk(child, here, false)
          if (found) return found
        }

        return undefined
      }

      return walk(frameTree, [], true) ?? []
    }

    const close = (): Effect.Effect<void> =>
      Effect.promise(() => cdp.detach().catch(() => undefined))

    return {
      observe,
      resolve,
      act,
      read,
      describe,
      screenshot,
      close,
      dispatch,
      startScreencast,
      describeAt,
    } satisfies WebSurface
  })

export { describeActor, describeHolder }
