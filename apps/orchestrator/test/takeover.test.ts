import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CapabilityArtifact,
  Step,
  type Intervention,
  type ReplayResult,
  type TakeoverClientMessage,
  type TakeoverServerMessage,
} from "@workspace/contracts"
import {
  buildTestCapability,
  button,
  makeEvidenceWriter,
  runReplay,
  testVault,
  type EvidenceWriter,
} from "@workspace/engine"
import { coreBankReadonly, makeRedactor } from "@workspace/policy"
import { Effect } from "effect"
import { startCoreBank, type CoreBankTestServer } from "target-corebank/testing"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { WebSocket } from "ws"

import {
  startLiveSession,
  type LiveSession,
} from "../src/server/live-session.js"

/**
 * The live-takeover loop, end to end, against the real application.
 *
 * This is the Phase 5 gate and the whole of §3.6: a replay reaches a step the
 * guardrail will not let it perform, **pauses**, hands the live browser session
 * to a person over a WebSocket, the person drives that same page, hands back —
 * and the run *continues and completes*. Nothing here is stubbed: a real
 * Chromium, a real CDP screencast, real `Input.dispatch*` events at real
 * coordinates, and the real replay executor blocked on the real intervention.
 *
 * The assertions people usually skip are the ones that matter most: that the
 * automation is genuinely *refused* while the operator holds the session, and
 * that what the operator did was captured in terms an artifact could be written
 * from.
 */

let corebank: CoreBankTestServer
let live: LiveSession
let evidence: EvidenceWriter
let evidenceRoot: string

const allowlistFor = (baseUrl: string) =>
  ({
    ...coreBankReadonly,
    allowedOrigins: [new URL(baseUrl).origin],
  }) as typeof coreBankReadonly

/**
 * The capability, with one step policy will not allow it to take.
 *
 * "Close Account" is irreversible, the artifact runs under a `safe` ceiling, and
 * so the guardrail asks for a person — which is exactly the situation live
 * takeover exists for: not a broken UI, but an action the system is deliberately
 * not permitted to take on its own.
 */
const closeAccountCapability = () => {
  const base = buildTestCapability()

  return new CapabilityArtifact({
    ...base,
    steps: [
      ...base.steps,
      new Step({
        id: "s8",
        intent: "Begin closing the member's savings account.",
        action: { _tag: "click", target: button("Close Account") },
        riskClass: "safe",
        // The confirmation page, and nothing else on the site, says this.
        checkpoint: { _tag: "textPresent", text: "Confirm Close Account" },
        timeoutMs: 10_000,
      }),
    ],
    successCondition: { _tag: "textPresent", text: "Confirm Close Account" },
  })
}

// ── WebSocket helper ─────────────────────────────────────────────────────

/**
 * A console, reduced to what a test needs: send typed messages, wait for one.
 *
 * Waiting on a *predicate* rather than sleeping is the same discipline the
 * replay engine uses — an assertion that races is worse than no assertion.
 */
class TestConsole {
  readonly received: TakeoverServerMessage[] = []
  readonly #socket: WebSocket
  readonly #waiters = new Set<{
    match: (message: TakeoverServerMessage) => boolean
    settle: (message: TakeoverServerMessage) => void
  }>()

  private constructor(socket: WebSocket) {
    this.#socket = socket

    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as TakeoverServerMessage
      this.received.push(message)

      for (const waiter of [...this.#waiters]) {
        if (!waiter.match(message)) continue
        this.#waiters.delete(waiter)
        waiter.settle(message)
      }
    })
  }

  static async connect(url: string): Promise<TestConsole> {
    const socket = new WebSocket(url)
    const console_ = new TestConsole(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve())
      socket.once("error", reject)
    })
    return console_
  }

  send(message: TakeoverClientMessage): void {
    this.#socket.send(JSON.stringify(message))
  }

  waitFor<T extends TakeoverServerMessage["_tag"]>(
    tag: T,
    predicate: (message: Extract<TakeoverServerMessage, { _tag: T }>) => boolean = () =>
      true,
    timeoutMs = 15_000
  ): Promise<Extract<TakeoverServerMessage, { _tag: T }>> {
    const already = this.received.find(
      (message): message is Extract<TakeoverServerMessage, { _tag: T }> =>
        message._tag === tag && predicate(message as never)
    )
    if (already) return Promise.resolve(already)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for "${tag}"`)),
        timeoutMs
      )

      this.#waiters.add({
        match: (message) =>
          message._tag === tag && predicate(message as never),
        settle: (message) => {
          clearTimeout(timer)
          resolve(message as Extract<TakeoverServerMessage, { _tag: T }>)
        },
      })
    })
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.#socket.once("close", () => resolve())
      this.#socket.close()
    })
  }
}

// ── Fixture ──────────────────────────────────────────────────────────────

/** Where the centre of a control is, in the coordinates input is sent in. */
const centreOf = async (description: ReturnType<typeof button>) => {
  const resolved = await Effect.runPromise(live.surface.resolve(description))
  const detail = await Effect.runPromise(live.surface.describe(resolved.handle))
  const bounds = detail.bounds

  if (!bounds) throw new Error("the control has no box to click")

  return {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
  }
}

/** Drive a real click the way a person's mouse does: move, press, release. */
const operatorClick = (
  console_: TestConsole,
  point: { x: number; y: number }
): void => {
  console_.send({ _tag: "input", event: { _tag: "mouseMoved", ...point } })
  console_.send({
    _tag: "input",
    event: { _tag: "mousePressed", ...point, button: "left", clickCount: 1 },
  })
  console_.send({
    _tag: "input",
    event: { _tag: "mouseReleased", ...point, button: "left", clickCount: 1 },
  })
}

let nextIntervention: Promise<Intervention>

/**
 * A promise that settles when the run raises its intervention.
 *
 * Armed *before* the run starts, because the escalation can happen before the
 * first `await` returns — a test that starts watching afterwards races the thing
 * it is testing.
 */
const armInterventionWaiter = () => {
  let settle: (intervention: Intervention) => void = () => {}
  nextIntervention = new Promise((resolve) => {
    settle = resolve
  })
  return settle
}

beforeAll(async () => {
  corebank = await startCoreBank()
  evidenceRoot = await mkdtemp(join(tmpdir(), "cua-takeover-"))
})

afterAll(async () => {
  await corebank.stop()
})

afterEach(async () => {
  await live?.close()
})

const startRun = async (options: { awaitTimeoutMs?: number } = {}) => {
  const onRaised = armInterventionWaiter()

  live = await startLiveSession({
    allowlist: allowlistFor(corebank.baseUrl),
    redactor: makeRedactor({ values: ["demo-pass"] }),
    awaitTimeoutMs: options.awaitTimeoutMs,
    onRaised,
  })

  evidence = await makeEvidenceWriter({
    root: evidenceRoot,
    runId: `takeover-${Date.now()}`,
    redactor: makeRedactor({ values: ["demo-pass"] }),
  })

  const result: Promise<ReplayResult> = Effect.runPromise(
    runReplay(
      {
        surface: live.surface,
        evidence,
        allowlist: allowlistFor(corebank.baseUrl),
        lease: live.lease,
        vault: testVault,
        escalator: live.registry,
        session: live.session,
      },
      {
        artifact: closeAccountCapability(),
        inputs: { memberId: "12345" },
        baseUrl: corebank.baseUrl,
      }
    )
  )

  return { result, intervention: nextIntervention }
}

// ── The gate ─────────────────────────────────────────────────────────────

describe("live takeover", () => {
  it("pauses, lets a human drive the same page, and then completes the run", async () => {
    const run = await startRun()
    const intervention = await run.intervention

    // The run stopped for the designed reason, and the intervention carries
    // enough context that the operator does not have to ask anybody anything.
    expect(intervention.trigger).toBe("policyRequiresApproval")
    expect(intervention.stepId).toBe("s8")
    expect(intervention.stepIntent).toContain("closing")
    expect(intervention.reason).toContain("irreversible")
    expect(intervention.screenshotRef).toBeDefined()
    expect(intervention.recentActions.length).toBeGreaterThan(0)

    expect(live.session.state()._tag).toBe("AwaitingOperator")

    const console_ = await TestConsole.connect(live.takeoverUrl)

    // A connection alone gets you the picture and the context.
    const hello = await console_.waitFor("hello")
    expect(hello.intervention?.id).toBe(intervention.id)

    // The screencast is real: pixels of the live page arrive unprompted.
    const frame = await console_.waitFor("frame")
    expect(frame.data.length).toBeGreaterThan(0)
    expect(frame.width).toBeGreaterThan(0)

    // …but it is not permission to act.
    console_.send({
      _tag: "input",
      event: { _tag: "mouseMoved", x: 10, y: 10 },
    })
    const refused = await console_.waitFor("denied")
    expect(refused.rule).toBe("controlLease")

    console_.send({
      _tag: "claim",
      interventionId: intervention.id,
      operatorId: "alice",
    })
    await console_.waitFor("state", (message) =>
      message.state._tag === "OperatorDriving"
    )

    /**
     * The automation is now *refused*, not merely idle. This is the assertion
     * that makes the handoff a transfer of control rather than a convention: a
     * run that failed to notice it had been paused cannot race the person who
     * took over from it.
     */
    const raced = await Effect.runPromise(
      Effect.either(
        live.surface.act(
          { _tag: "automation", runId: "some-run" },
          { _tag: "navigate", url: corebank.baseUrl }
        )
      )
    )
    expect(raced._tag).toBe("Left")
    if (raced._tag === "Left") expect(raced.left._tag).toBe("ControlDenied")

    // The operator does by hand the thing the automation was refused.
    operatorClick(console_, await centreOf(button("Close Account")))

    const captured = await console_.waitFor("captured")
    expect(captured.action.kind).toBe("click")
    // Captured symbolically as well as positionally — this is what makes the
    // log promotable into an artifact step rather than a list of pixels.
    expect(captured.action.targetName).toBe("Close Account")
    expect(captured.action.point).toBeDefined()

    console_.send({ _tag: "handback", disposition: "skipStep" })
    await console_.waitFor("resumed")

    const result = await run.result

    // The gate: the run *completed*, having been finished partly by a person.
    expect(result._tag).toBe("Succeeded")

    const handedOver = result.trace.find(
      (event) => event._tag === "ControlHandedOver"
    )
    const returned = result.trace.find(
      (event) => event._tag === "ControlReturned"
    )

    expect(handedOver).toBeDefined()
    expect(returned).toMatchObject({
      by: "alice",
      disposition: "skipStep",
      operatorActions: 1,
    })

    // The session is free again, so the next run can have it.
    expect(live.session.state()._tag).toBe("Idle")

    await console_.close()
  })

  it("ends the run as Escalated when the operator aborts", async () => {
    const run = await startRun()
    const intervention = await run.intervention

    const console_ = await TestConsole.connect(live.takeoverUrl)
    await console_.waitFor("hello")

    console_.send({
      _tag: "claim",
      interventionId: intervention.id,
      operatorId: "bob",
    })
    await console_.waitFor("state", (message) =>
      message.state._tag === "OperatorDriving"
    )

    console_.send({ _tag: "abort", note: "Needs a supervisor." })

    const result = await run.result

    expect(result._tag).toBe("Escalated")
    if (result._tag !== "Escalated") return
    expect(result.atStepId).toBe("s8")
    expect(result.reason).toContain("supervisor")

    await console_.close()
  })

  it("refuses a second operator without disturbing the first", async () => {
    const run = await startRun()
    const intervention = await run.intervention

    const alice = await TestConsole.connect(live.takeoverUrl)
    const bob = await TestConsole.connect(live.takeoverUrl)
    await alice.waitFor("hello")
    await bob.waitFor("hello")

    alice.send({
      _tag: "claim",
      interventionId: intervention.id,
      operatorId: "alice",
    })
    await alice.waitFor("state", (message) =>
      message.state._tag === "OperatorDriving"
    )

    bob.send({
      _tag: "claim",
      interventionId: intervention.id,
      operatorId: "bob",
    })
    const denied = await bob.waitFor("denied")
    expect(denied.reason).toContain("alice")

    // Bob still sees everything — a supervisor watching is not a second driver.
    expect(live.session.state()).toMatchObject({ operatorId: "alice" })

    alice.send({ _tag: "abort" })
    await run.result

    await alice.close()
    await bob.close()
  })

  it("returns an abandoned session to the queue instead of resuming the run", async () => {
    // A short bound so the test does not sit on a run nobody comes back to.
    const run = await startRun({ awaitTimeoutMs: 4_000 })
    const intervention = await run.intervention

    const console_ = await TestConsole.connect(live.takeoverUrl)
    await console_.waitFor("hello")

    console_.send({
      _tag: "claim",
      interventionId: intervention.id,
      operatorId: "carol",
    })
    await console_.waitFor("state", (message) =>
      message.state._tag === "OperatorDriving"
    )

    // Carol's laptop sleeps. She decided nothing, so the run must not resume.
    await console_.close()

    await expect
      .poll(() => live.session.state()._tag, { timeout: 5_000 })
      .toBe("AwaitingOperator")

    const result = await run.result
    expect(result._tag).toBe("Escalated")
    if (result._tag !== "Escalated") return
    expect(result.reason).toContain("No operator responded")
  })
})
