import {
  decodeTakeoverClientMessage,
  OperatorAction,
  type ControlState,
  type Intervention,
  type OperatorInput,
  type TakeoverServerMessage,
} from "@workspace/contracts"
import type { InterventionRegistry, Session } from "@workspace/engine"
import {
  classifyRisk,
  decide,
  type AllowlistConfig,
  type Redactor,
} from "@workspace/policy"
import type {
  PointDescription,
  Screencast,
  TakeoverSurface,
} from "@workspace/surface"
import { Effect } from "effect"
import type { WebSocket } from "ws"

/**
 * The live-takeover gateway.
 *
 * This is the part of the design that had to be built rather than described: the
 * operator drives **the same page** the automation was driving — same browser
 * context, same cookies, same half-filled form — over CDP screencast out and CDP
 * input in. Anything that reproduced the state in a second browser would fail
 * exactly when it is needed, because reproducing a legacy session is the hard
 * problem, not rendering it.
 *
 * Three properties are load-bearing:
 *
 *  1. **A socket is not permission.** Connecting gets you frames. Acting requires
 *     holding the control lease, which requires claiming an intervention that is
 *     genuinely awaiting one. Every input goes through the same lease check as an
 *     automation action, so a revoked claim stops input mid-stream.
 *  2. **Everything the operator does is captured.** Coordinates for fidelity,
 *     role and name from the accessibility tree for reviewability. That log is
 *     evidence, and it is the raw material for promoting a human fix into a new
 *     artifact version.
 *  3. **Navigation is policed, clicks are not.** An operator asking the browser
 *     to go somewhere is checked against the same allowlist as the automation —
 *     otherwise the takeover channel is an exfiltration path out of a machine
 *     that holds banking credentials. A *click* is deliberately not blocked: the
 *     intervention usually exists precisely so a person can press the button
 *     policy refused. It is classified and recorded, loudly, instead.
 */

export interface TakeoverGatewayOptions {
  readonly session: Session
  readonly registry: InterventionRegistry
  readonly surface: TakeoverSurface
  readonly allowlist: AllowlistConfig
  readonly redactor: Redactor
  readonly onEvent?: (event: Record<string, unknown>) => void
  /** JPEG quality for the screencast. Lower is a smoother control channel. */
  readonly quality?: number
}

interface Connection {
  readonly socket: WebSocket
  /** Set once this connection has successfully claimed an intervention. */
  operatorId?: string
  interventionId?: string
  /**
   * Messages are handled strictly in order, one at a time.
   *
   * Input is a sequence, not a set. Handling a press and a release
   * concurrently — the press pauses to read the accessibility tree, the release
   * does not — delivers them to the browser in the wrong order, and a mouse-up
   * before its mouse-down is not a click. It fails silently, which is the worst
   * way for it to fail.
   */
  queue: Promise<void>
}

/** Keys that end a run of typing rather than contributing to it. */
const TERMINATES_TYPING = /^(Enter|Tab|Escape)$/

export interface TakeoverGateway {
  readonly handleConnection: (socket: WebSocket) => void
  readonly close: () => Promise<void>
  readonly connectionCount: () => number
}

export const makeTakeoverGateway = ({
  session,
  registry,
  surface,
  allowlist,
  redactor,
  onEvent,
  quality = 60,
}: TakeoverGatewayOptions): TakeoverGateway => {
  const connections = new Set<Connection>()
  let screencast: Screencast | undefined

  const send = (socket: WebSocket, message: TakeoverServerMessage): void => {
    if (socket.readyState !== socket.OPEN) return
    socket.send(JSON.stringify(message))
  }

  const broadcast = (message: TakeoverServerMessage): void => {
    for (const connection of connections) send(connection.socket, message)
  }

  // Every state change reaches every watcher, so a console that did not cause
  // the transition still shows the truth.
  const unsubscribe = session.subscribe((state: ControlState) => {
    broadcast({ _tag: "state", state })
  })

  /**
   * Frames flow only while somebody is watching.
   *
   * A screencast is a continuous stream of JPEG encodes on the browser's main
   * thread. Leaving one running against an unattended replay would make every
   * headless run slower in exchange for pixels nobody sees.
   */
  const ensureScreencast = async (): Promise<void> => {
    if (screencast) return

    screencast = await Effect.runPromise(
      surface.startScreencast(
        (frame) =>
          broadcast({
            _tag: "frame",
            data: frame.data,
            width: frame.width,
            height: frame.height,
            at: frame.at,
          }),
        { quality }
      )
    ).catch(() => undefined)
  }

  const stopScreencastIfIdle = async (): Promise<void> => {
    if (connections.size > 0 || !screencast) return
    const running = screencast
    screencast = undefined
    await Effect.runPromise(running.stop()).catch(() => undefined)
  }

  // ── Operator capture ───────────────────────────────────────────────────

  /**
   * Keystrokes are buffered into one `type` action rather than logged per key.
   *
   * A log of eleven `keyDown` entries is faithful and unreadable, and it is not
   * promotable — a capability step types a value, it does not press keys. The
   * buffer flushes on anything that ends a field: a terminating key, a click
   * elsewhere, or the handback itself.
   */
  let typing:
    | { text: string; role?: string; name?: string; frame: readonly string[] }
    | undefined

  /**
   * The last control the operator clicked, which is where their typing goes.
   *
   * Chromium can report the focused node, but a takeover's typing almost always
   * follows a click into the field, and using the click keeps the captured
   * target and the captured action describing the same thing.
   */
  let lastClicked:
    | { role?: string; name?: string; frame: readonly string[] }
    | undefined

  const capture = (connection: Connection, action: OperatorAction): void => {
    if (!connection.interventionId) return
    session.captureOperatorAction(connection.interventionId, action)
    send(connection.socket, { _tag: "captured", action })
  }

  const flushTyping = (connection: Connection): void => {
    if (!typing || typing.text.length === 0) {
      typing = undefined
      return
    }

    capture(
      connection,
      new OperatorAction({
        at: new Date().toISOString(),
        kind: "type",
        targetRole: typing.role,
        targetName: typing.name,
        frame: typing.frame,
        // The operator may well be typing a password into the sign-on screen
        // they were called in to fix. It goes through the same redactor as
        // everything else the system writes down.
        text: redactor.text(typing.text),
      })
    )

    typing = undefined
  }

  /**
   * What was under the cursor when the button went down.
   *
   * Read *before* the input is dispatched, not after. A click on a submit button
   * navigates, and by the time the release has been forwarded the node it landed
   * on no longer exists — describing afterwards yields an empty accessibility
   * answer, which is how this was found. The press is also the honest target: a
   * click belongs to where the mouse went down.
   */
  let pressedOn: PointDescription | undefined

  const describePoint = async (x: number, y: number) =>
    Effect.runPromise(surface.describeAt(x, y)).catch(() => ({
      frame: [] as readonly string[],
      role: undefined,
      name: undefined,
      value: undefined,
    }))

  const captureInput = async (
    connection: Connection,
    event: OperatorInput
  ): Promise<void> => {
    switch (event._tag) {
      case "mouseReleased": {
        // Capture on release, not press: a press that never released is a drag,
        // and calling that a click would put a fiction in the audit log.
        flushTyping(connection)

        const at = pressedOn ?? (await describePoint(event.x, event.y))
        pressedOn = undefined
        lastClicked = { role: at.role, name: at.name, frame: at.frame }

        // Classified, not decided: `decide` would answer the origin question
        // too, and a click has no URL of its own. What matters here is only
        // what the control says it does.
        const riskClass = classifyRisk(allowlist, {
          kind: "click",
          url: "",
          targetLabel: at.name,
        })

        capture(
          connection,
          new OperatorAction({
            at: new Date().toISOString(),
            kind: "click",
            targetRole: at.role,
            targetName: at.name,
            frame: at.frame,
            point: { x: event.x, y: event.y },
          })
        )

        // Not a refusal — the takeover usually exists so a person can do this.
        // But an irreversible action taken by hand is the single most important
        // line in an audit trail, so it is recorded as its own event.
        if (riskClass !== "safe") {
          onEvent?.({
            kind: "OperatorRiskyAction",
            operatorId: connection.operatorId,
            interventionId: connection.interventionId,
            riskClass,
            control: at.name,
          })
        }
        return
      }

      case "keyDown": {
        const printable = event.text ?? (event.key.length === 1 ? event.key : undefined)

        if (printable && !TERMINATES_TYPING.test(event.key)) {
          typing ??= {
            text: "",
            frame: lastClicked?.frame ?? [],
            role: lastClicked?.role,
            name: lastClicked?.name,
          }
          typing.text += printable
          return
        }

        flushTyping(connection)

        capture(
          connection,
          new OperatorAction({
            at: new Date().toISOString(),
            kind: "key",
            text: event.key,
          })
        )
        return
      }

      case "insertText":
        flushTyping(connection)
        capture(
          connection,
          new OperatorAction({
            at: new Date().toISOString(),
            kind: "type",
            text: redactor.text(event.text),
          })
        )
        return

      default:
        // Moves, wheels and key-ups are not decisions. Logging them would bury
        // the ones that are.
        return
    }
  }

  // ── Message handling ───────────────────────────────────────────────────

  const currentIntervention = (): Intervention | null => {
    const state = session.state()
    const id =
      state._tag === "AwaitingOperator" ||
      state._tag === "OperatorDriving" ||
      state._tag === "PauseRequested" ||
      state._tag === "HandbackRequested"
        ? state.interventionId
        : undefined

    return (id ? registry.get(id) : undefined) ?? null
  }

  const handleMessage = async (
    connection: Connection,
    raw: string
  ): Promise<void> => {
    const parsed = await Effect.runPromise(
      Effect.either(
        Effect.flatMap(
          Effect.try({
            try: () => JSON.parse(raw) as unknown,
            catch: () => new Error("not JSON"),
          }),
          decodeTakeoverClientMessage
        )
      )
    )

    if (parsed._tag === "Left") {
      send(connection.socket, {
        _tag: "denied",
        reason: "Unrecognised message.",
      })
      return
    }

    const message = parsed.right

    switch (message._tag) {
      case "ping":
        send(connection.socket, { _tag: "pong" })
        return

      case "claim": {
        const claimed = registry.claim(
          message.interventionId,
          message.operatorId
        )

        if (!claimed.ok) {
          send(connection.socket, { _tag: "denied", reason: claimed.reason })
          return
        }

        connection.operatorId = message.operatorId
        connection.interventionId = message.interventionId
        return
      }

      case "input": {
        if (!connection.operatorId) {
          send(connection.socket, {
            _tag: "denied",
            reason: "Claim the intervention before driving.",
            rule: "controlLease",
          })
          return
        }

        if (message.event._tag === "mousePressed") {
          pressedOn = await describePoint(message.event.x, message.event.y)
        }

        const dispatched = await Effect.runPromise(
          Effect.either(
            surface.dispatch(
              { _tag: "operator", operatorId: connection.operatorId },
              message.event
            )
          )
        )

        if (dispatched._tag === "Left") {
          // The lease moved while this socket was still holding a mouse down.
          send(connection.socket, {
            _tag: "denied",
            reason: `Input refused: ${dispatched.left._tag}.`,
            rule: "controlLease",
          })
          return
        }

        await captureInput(connection, message.event)
        return
      }

      case "navigate": {
        if (!connection.operatorId) {
          send(connection.socket, {
            _tag: "denied",
            reason: "Claim the intervention before driving.",
            rule: "controlLease",
          })
          return
        }

        const decision = decide(
          allowlist,
          { phase: "replay", maxRiskClass: "irreversible" },
          { kind: "navigate", url: message.url }
        )

        if (decision._tag === "Deny") {
          onEvent?.({
            kind: "OperatorNavigationDenied",
            operatorId: connection.operatorId,
            url: message.url,
            rule: decision.rule,
          })
          send(connection.socket, {
            _tag: "denied",
            reason: decision.reason,
            rule: decision.rule,
          })
          return
        }

        await Effect.runPromise(
          Effect.either(
            session.surface.act(
              { _tag: "operator", operatorId: connection.operatorId },
              { _tag: "navigate", url: message.url }
            )
          )
        )

        capture(
          connection,
          new OperatorAction({
            at: new Date().toISOString(),
            kind: "navigate",
            url: message.url,
          })
        )
        return
      }

      case "handback":
      case "abort": {
        if (!connection.operatorId || !connection.interventionId) {
          send(connection.socket, {
            _tag: "denied",
            reason: "You are not driving this session.",
          })
          return
        }

        flushTyping(connection)

        const interventionId = connection.interventionId
        const resolved = registry.resolve(
          interventionId,
          message._tag === "abort"
            ? { _tag: "abort", note: message.note }
            : {
                _tag: "resume",
                disposition: message.disposition,
                note: message.note,
              }
        )

        if (!resolved.ok) {
          send(connection.socket, { _tag: "denied", reason: resolved.reason })
          return
        }

        connection.operatorId = undefined
        connection.interventionId = undefined

        broadcast({
          _tag: "resumed",
          interventionId,
          disposition:
            message._tag === "abort" ? "abort" : message.disposition,
        })
        return
      }
    }
  }

  return {
    handleConnection: (socket) => {
      const connection: Connection = { socket, queue: Promise.resolve() }
      connections.add(connection)

      void ensureScreencast()

      send(socket, {
        _tag: "hello",
        sessionId: session.id,
        state: session.state(),
        intervention: currentIntervention(),
      })

      socket.on("message", (data) => {
        connection.queue = connection.queue.then(() =>
          handleMessage(connection, String(data)).catch(() => undefined)
        )
      })

      socket.on("close", () => {
        connections.delete(connection)

        /**
         * A dropped socket returns the session to the queue — it never resumes
         * the run. An operator whose laptop slept mid-form has not decided
         * anything, and inferring a decision from a disconnect is how automation
         * finishes a transfer a human abandoned halfway.
         */
        if (connection.interventionId) {
          flushTyping(connection)
          registry.release(connection.interventionId)
        }

        void stopScreencastIfIdle()
      })
    },

    connectionCount: () => connections.size,

    close: async () => {
      unsubscribe()
      for (const connection of connections) connection.socket.close()
      connections.clear()
      await stopScreencastIfIdle()
    },
  }
}
