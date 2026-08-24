import type { ControlState } from "@workspace/contracts"

/**
 * The control-transfer state machine, as a pure function.
 *
 * Handing a live browser session between a program and a person is the part of
 * this system most likely to go wrong in a way nobody notices: two actors both
 * believing they hold the session, or a run resuming while a human is still
 * typing. So the transfer is a state machine with an explicit transition table,
 * and it is pure — no browser, no sockets, no timers — which means every illegal
 * transition can be tested directly rather than provoked.
 *
 * The rule the whole thing exists to enforce: **control moves only through
 * declared transitions.** There is no `setState`. Everything above this — the
 * lease, the surface's refusal to act, the gateway's refusal to forward input —
 * is downstream of what this returns.
 */

export type ControlEvent =
  /** A run takes an idle session. */
  | { readonly _tag: "runStarted"; readonly runId: string }
  /**
   * Something asked the run to stop. The run does *not* stop here: the action in
   * flight is allowed to complete, because abandoning a dispatched click leaves
   * the operator with a half-submitted form and no way to know it.
   */
  | { readonly _tag: "pauseRequested"; readonly interventionId: string }
  /** The in-flight action finished. Now it is safe to hand over. */
  | { readonly _tag: "paused" }
  | { readonly _tag: "claimed"; readonly operatorId: string }
  /** The operator disconnected without handing back. */
  | { readonly _tag: "released" }
  | {
      readonly _tag: "handbackRequested"
      readonly disposition: "retryStep" | "skipStep" | "abort"
    }
  /** The run has picked control back up and is driving again. */
  | { readonly _tag: "resumed" }
  /** The run ended, whatever way it ended. */
  | { readonly _tag: "runFinished" }

export type Transition =
  | { readonly _tag: "ok"; readonly state: ControlState }
  /**
   * Rejected, with a reason. Deliberately not an exception: an operator clicking
   * "take control" twice is ordinary, and the second click should be answered,
   * not crash the gateway.
   */
  | { readonly _tag: "rejected"; readonly reason: string }

const ok = (state: ControlState): Transition => ({ _tag: "ok", state })
const rejected = (reason: string): Transition => ({ _tag: "rejected", reason })

const wrongState = (event: ControlEvent, state: ControlState): Transition =>
  rejected(`Cannot ${event._tag} while the session is ${state._tag}.`)

export const initialControlState: ControlState = { _tag: "Idle" }

export const transition = (
  state: ControlState,
  event: ControlEvent
): Transition => {
  switch (event._tag) {
    case "runStarted":
      return state._tag === "Idle"
        ? ok({ _tag: "AutomationDriving", runId: event.runId })
        : wrongState(event, state)

    case "pauseRequested":
      return state._tag === "AutomationDriving"
        ? ok({
            _tag: "PauseRequested",
            runId: state.runId,
            interventionId: event.interventionId,
          })
        : wrongState(event, state)

    case "paused":
      return state._tag === "PauseRequested"
        ? ok({
            _tag: "AwaitingOperator",
            runId: state.runId,
            interventionId: state.interventionId,
          })
        : wrongState(event, state)

    case "claimed":
      /**
       * Only one operator at a time, and only from `AwaitingOperator`. A second
       * console watching the same intervention is refused the lease rather than
       * stealing it — it can still see every frame, which is what a supervisor
       * actually wants.
       */
      if (state._tag === "OperatorDriving") {
        return rejected(
          `${state.operatorId} is already driving this session.`
        )
      }
      return state._tag === "AwaitingOperator"
        ? ok({
            _tag: "OperatorDriving",
            runId: state.runId,
            interventionId: state.interventionId,
            operatorId: event.operatorId,
          })
        : wrongState(event, state)

    case "released":
      /**
       * A dropped connection returns the session to the queue; it never resumes
       * the run. An operator who closed their laptop mid-form has not decided
       * anything, and inferring that they had is how automation finishes a
       * half-completed transfer.
       */
      return state._tag === "OperatorDriving" ||
        state._tag === "HandbackRequested"
        ? ok({
            _tag: "AwaitingOperator",
            runId: state.runId,
            interventionId: state.interventionId,
          })
        : wrongState(event, state)

    case "handbackRequested":
      return state._tag === "OperatorDriving"
        ? ok({
            _tag: "HandbackRequested",
            runId: state.runId,
            interventionId: state.interventionId,
            operatorId: state.operatorId,
            disposition: event.disposition,
          })
        : wrongState(event, state)

    case "resumed":
      if (state._tag !== "HandbackRequested") return wrongState(event, state)
      // An aborted handback does not give the session back to the run.
      return ok(
        state.disposition === "abort"
          ? { _tag: "Idle" }
          : { _tag: "AutomationDriving", runId: state.runId }
      )

    case "runFinished":
      return state._tag === "Idle"
        ? wrongState(event, state)
        : ok({ _tag: "Idle" })
  }
}

/** The intervention this session is currently blocked on, if any. */
export const pendingInterventionId = (
  state: ControlState
): string | undefined =>
  state._tag === "PauseRequested" ||
  state._tag === "AwaitingOperator" ||
  state._tag === "OperatorDriving" ||
  state._tag === "HandbackRequested"
    ? state.interventionId
    : undefined

export const describeControlState = (state: ControlState): string => {
  switch (state._tag) {
    case "Idle":
      return "idle"
    case "AutomationDriving":
      return `automation ${state.runId} is driving`
    case "PauseRequested":
      return "pausing — finishing the action in flight"
    case "AwaitingOperator":
      return "paused, waiting for an operator"
    case "OperatorDriving":
      return `${state.operatorId} is driving`
    case "HandbackRequested":
      return `${state.operatorId} handed back (${state.disposition})`
  }
}
