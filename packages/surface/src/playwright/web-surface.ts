import { randomUUID } from "node:crypto"

import type { Observation, TargetDescriptor } from "@workspace/contracts"
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
  Actor,
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

export interface WebSurfaceOptions {
  readonly page: Page
  readonly lease: ControlLease
  readonly defaultTimeoutMs?: number
}

export const makeWebSurface = ({
  page,
  lease,
  defaultTimeoutMs = 10_000,
}: WebSurfaceOptions): Effect.Effect<Surface, SurfaceUnavailable> =>
  Effect.gen(function* () {
    const cdp: CDPSession = yield* Effect.tryPromise({
      try: async () => {
        const session = await page.context().newCDPSession(page)
        await session.send("Accessibility.enable")
        await session.send("DOM.enable")
        return session
      },
      catch: (cause) =>
        new SurfaceUnavailable({
          detail: `could not attach CDP: ${String(cause)}`,
        }),
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
        try: () => readObservation(page, cdp),
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

    const read = (handle: TargetHandle): Effect.Effect<string, SurfaceError> =>
      Effect.tryPromise({
        try: () =>
          handle._tag === "point"
            ? Promise.reject(
                new Error("cannot read text from a coordinate handle")
              )
            : withElement(handle, (locator) =>
                locator.innerText({ timeout: defaultTimeoutMs })
              ),
        catch: (cause) =>
          new InteractionFailed({ command: "read", detail: String(cause) }),
      })

    const screenshot = (): Effect.Effect<Uint8Array, SurfaceError> =>
      Effect.tryPromise({
        try: async () => new Uint8Array(await page.screenshot({ type: "png" })),
        catch: (cause) => new SurfaceUnavailable({ detail: String(cause) }),
      })

    const close = (): Effect.Effect<void> =>
      Effect.promise(() => cdp.detach().catch(() => undefined))

    return { observe, resolve, act, read, screenshot, close } satisfies Surface
  })

export { describeActor, describeHolder }
