import { controlHolderOf, type ControlState } from "@workspace/contracts"
import { describe, expect, it } from "vitest"

import {
  describeControlState,
  initialControlState,
  pendingInterventionId,
  transition,
  type ControlEvent,
} from "./control-state.js"

/**
 * The transfer of control, tested as a machine rather than through a browser.
 *
 * These are the cases that are almost impossible to provoke on purpose in an
 * integration test — two operators racing for the same intervention, a socket
 * dropping between handback and resume — and are exactly the ones that would
 * produce two actors believing they hold the same banking session.
 */

const drive = (events: readonly ControlEvent[]): ControlState => {
  let state = initialControlState

  for (const event of events) {
    const result = transition(state, event)
    if (result._tag === "rejected") {
      throw new Error(`unexpected rejection: ${result.reason}`)
    }
    state = result.state
  }

  return state
}

const toOperator: readonly ControlEvent[] = [
  { _tag: "runStarted", runId: "run-1" },
  { _tag: "pauseRequested", interventionId: "int-1" },
  { _tag: "paused" },
  { _tag: "claimed", operatorId: "alice" },
]

describe("the control transfer state machine", () => {
  it("walks the whole loop: automation → operator → automation", () => {
    const state = drive([
      ...toOperator,
      { _tag: "handbackRequested", disposition: "skipStep" },
      { _tag: "resumed" },
    ])

    expect(state).toEqual({ _tag: "AutomationDriving", runId: "run-1" })
  })

  it("keeps the run holding the session while its action is still in flight", () => {
    const state = drive([
      { _tag: "runStarted", runId: "run-1" },
      { _tag: "pauseRequested", interventionId: "int-1" },
    ])

    // The point of PauseRequested: a dispatched click has to be allowed to land,
    // so the automation still holds control until it has.
    expect(state._tag).toBe("PauseRequested")
    expect(controlHolderOf(state)).toEqual({ kind: "automation", id: "run-1" })
  })

  it("gives the session to nobody while it waits for an operator", () => {
    const state = drive([...toOperator.slice(0, 3)])

    expect(state._tag).toBe("AwaitingOperator")
    // An automation command arriving now is refused, which is what should happen
    // to a run that did not notice it had been paused.
    expect(controlHolderOf(state)).toEqual({ kind: "none" })
  })

  it("refuses a second operator rather than transferring the lease", () => {
    const state = drive(toOperator)
    const result = transition(state, { _tag: "claimed", operatorId: "bob" })

    expect(result._tag).toBe("rejected")
    if (result._tag !== "rejected") return
    expect(result.reason).toContain("alice")
  })

  it("returns an abandoned session to the queue instead of resuming the run", () => {
    const state = drive([...toOperator, { _tag: "released" }])

    // An operator who closed their laptop mid-form decided nothing. Inferring a
    // decision from a disconnect is how automation completes a half-done
    // transfer.
    expect(state._tag).toBe("AwaitingOperator")
    expect(pendingInterventionId(state)).toBe("int-1")
  })

  it("does not hand an aborted session back to the run", () => {
    const state = drive([
      ...toOperator,
      { _tag: "handbackRequested", disposition: "abort" },
      { _tag: "resumed" },
    ])

    expect(state).toEqual({ _tag: "Idle" })
  })

  it("refuses to pause a session no run is driving", () => {
    const result = transition(initialControlState, {
      _tag: "pauseRequested",
      interventionId: "int-1",
    })

    expect(result._tag).toBe("rejected")
  })

  it("refuses to claim a session that was never paused", () => {
    const state = drive([{ _tag: "runStarted", runId: "run-1" }])
    const result = transition(state, { _tag: "claimed", operatorId: "alice" })

    expect(result._tag).toBe("rejected")
  })

  it("refuses a second run on a session that is already taken", () => {
    const state = drive([{ _tag: "runStarted", runId: "run-1" }])
    const result = transition(state, { _tag: "runStarted", runId: "run-2" })

    expect(result._tag).toBe("rejected")
  })

  it("frees the session however the run ended", () => {
    for (const state of [
      drive([{ _tag: "runStarted", runId: "run-1" }]),
      drive(toOperator),
      drive([...toOperator.slice(0, 3)]),
    ]) {
      const result = transition(state, { _tag: "runFinished" })
      expect(result._tag).toBe("ok")
      if (result._tag !== "ok") continue
      expect(result.state).toEqual({ _tag: "Idle" })
    }
  })

  it("names the intervention every blocked state is blocked on", () => {
    expect(pendingInterventionId(initialControlState)).toBeUndefined()
    expect(pendingInterventionId(drive(toOperator))).toBe("int-1")
  })

  it("describes every state, so the console never renders a tag", () => {
    const states: ControlState[] = [
      initialControlState,
      drive([{ _tag: "runStarted", runId: "run-1" }]),
      drive([...toOperator.slice(0, 2)]),
      drive([...toOperator.slice(0, 3)]),
      drive(toOperator),
      drive([...toOperator, { _tag: "handbackRequested", disposition: "skipStep" }]),
    ]

    for (const state of states) {
      expect(describeControlState(state)).not.toBe("")
    }
  })
})
