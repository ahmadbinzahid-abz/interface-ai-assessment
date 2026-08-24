import { createServer, type Server } from "node:http"

import type { Intervention } from "@workspace/contracts"
import { InterventionRegistry, Session } from "@workspace/engine"
import type { AllowlistConfig, Redactor } from "@workspace/policy"
import { ControlLease, makeWebSurface, type WebSurface } from "@workspace/surface"
import { Effect } from "effect"
import { chromium, type Browser } from "playwright"
import { WebSocketServer } from "ws"

import { makeTakeoverGateway, type TakeoverGateway } from "./takeover.js"

/**
 * A browser, a session, an intervention queue and a takeover gateway, wired up.
 *
 * The assembly is the interesting part, and it is deliberately one function: the
 * lease belongs to the session, the session belongs to the browser context, and
 * the gateway is the only thing that may hand the lease to a person. Constructing
 * those separately is how you end up with two leases and a run that thinks it
 * still has control.
 *
 * It exists apart from the CLI and the HTTP API because both need exactly this,
 * and so does the integration test that proves the loop closes.
 */

export interface LiveSessionOptions {
  readonly allowlist: AllowlistConfig
  readonly redactor: Redactor
  readonly headed?: boolean
  readonly viewport?: { readonly width: number; readonly height: number }
  /** Where the takeover socket listens. 0 picks a free port, which tests want. */
  readonly port?: number
  readonly onEvent?: (event: Record<string, unknown>) => void
  readonly onRaised?: (intervention: Intervention) => void
  /** Bound on how long a run waits for a person. Undefined waits indefinitely. */
  readonly awaitTimeoutMs?: number
}

export interface LiveSession {
  readonly session: Session
  readonly registry: InterventionRegistry
  readonly surface: WebSurface
  readonly lease: ControlLease
  readonly gateway: TakeoverGateway
  /** `ws://127.0.0.1:<port>/takeover` — what an operator console connects to. */
  readonly takeoverUrl: string
  readonly close: () => Promise<void>
}

export const startLiveSession = async (
  options: LiveSessionOptions
): Promise<LiveSession> => {
  const browser: Browser = await chromium.launch({ headless: !options.headed })
  const page = await browser.newPage({
    viewport: options.viewport ?? { width: 1280, height: 900 },
  })

  const lease = new ControlLease()
  const surface = await Effect.runPromise(makeWebSurface({ page, lease }))

  const session = new Session({ surface, lease, onEvent: options.onEvent })

  const registry = new InterventionRegistry({
    session,
    awaitTimeoutMs: options.awaitTimeoutMs,
    onEvent: options.onEvent,
    onRaised: options.onRaised,
  })

  const gateway = makeTakeoverGateway({
    session,
    registry,
    surface,
    allowlist: options.allowlist,
    redactor: options.redactor,
    onEvent: options.onEvent,
  })

  const http: Server = createServer((_request, response) => {
    // The socket is the interface. A bare GET exists only so a person poking at
    // the port gets an answer instead of a hang.
    response.writeHead(200, { "content-type": "text/plain" })
    response.end("cua takeover gateway\n")
  })

  const sockets = new WebSocketServer({ server: http, path: "/takeover" })
  sockets.on("connection", (socket) => gateway.handleConnection(socket))

  const port = await new Promise<number>((resolve) => {
    http.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = http.address()
      resolve(typeof address === "object" && address ? address.port : 0)
    })
  })

  return {
    session,
    registry,
    surface,
    lease,
    gateway,
    takeoverUrl: `ws://127.0.0.1:${port}/takeover`,

    close: async () => {
      await gateway.close()
      await new Promise<void>((resolve) => sockets.close(() => resolve()))
      await new Promise<void>((resolve) => http.close(() => resolve()))
      await Effect.runPromise(surface.close()).catch(() => undefined)
      await browser.close()
    },
  }
}
