import { randomUUID } from "node:crypto"

import {
  controlHolderOf,
  OperatorAction,
  type ControlState,
} from "@workspace/contracts"
import type { ControlLease, Surface } from "@workspace/surface"

import {
  initialControlState,
  transition,
  type ControlEvent,
  type Transition,
} from "./control-state.js"

/**
 * One browser context, held open across everything that happens to it.
 *
 * A session outlives a single replay on purpose. That is the whole reason live
 * takeover can work at all: when a run stops and a human takes over, they must
 * land on *the same page* with the same cookies and the same half-filled form,
 * not on a fresh browser that has to be signed on again. Reproducing the state
 * would be the thing that fails, and it would fail during an incident.
 *
 * The session owns the state machine and the lease together, and it is the only
 * thing that writes the lease. Every other component reads the consequences:
 * the surface refuses an actor who does not hold it, the gateway refuses to
 * forward input, the executor waits. Deriving the lease from the state rather
 * than setting both means the two cannot disagree — the bug class where the UI
 * says "you have control" and the surface says otherwise is unrepresentable.
 */

export interface SessionOptions {
  readonly surface: Surface
  readonly lease: ControlLease
  readonly id?: string
  /** Where operator actions go. The same writer the run is already using. */
  readonly onEvent?: (event: Record<string, unknown>) => void
}

export type SessionListener = (state: ControlState) => void

export class Session {
  readonly id: string
  readonly surface: Surface

  readonly #lease: ControlLease
  readonly #listeners = new Set<SessionListener>()
  readonly #onEvent?: (event: Record<string, unknown>) => void
  /** Keyed by intervention, because one run can be interrupted more than once. */
  readonly #operatorActions = new Map<string, OperatorAction[]>()

  #state: ControlState = initialControlState

  constructor({ surface, lease, id, onEvent }: SessionOptions) {
    this.id = id ?? `session-${randomUUID().slice(0, 8)}`
    this.surface = surface
    this.#lease = lease
    this.#onEvent = onEvent
  }

  state(): ControlState {
    return this.#state
  }

  /**
   * The only way the session changes hands.
   *
   * Returns the rejection rather than throwing it: an operator clicking "take
   * control" on an intervention someone else already claimed is a normal race,
   * and the answer is a message on their screen, not a crashed gateway.
   */
  apply(event: ControlEvent): Transition {
    const result = transition(this.#state, event)
    if (result._tag === "rejected") return result

    this.#state = result.state
    this.#syncLease()

    this.#onEvent?.({
      kind: "ControlTransition",
      event: event._tag,
      state: result.state._tag,
      sessionId: this.id,
    })

    for (const listener of this.#listeners) listener(result.state)

    return result
  }

  /** The lease is derived, never assigned. */
  #syncLease(): void {
    const holder = controlHolderOf(this.#state)

    if (holder.kind === "automation" && holder.id) {
      this.#lease.grantTo({ _tag: "automation", runId: holder.id })
      return
    }

    if (holder.kind === "operator" && holder.id) {
      this.#lease.grantTo({ _tag: "operator", operatorId: holder.id })
      return
    }

    // Nobody holds a paused session. An automation command arriving in this
    // window is refused, which is exactly what should happen to a run that did
    // not notice it had been paused.
    this.#lease.release()
  }

  subscribe(listener: SessionListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Record what the operator did.
   *
   * Every action, not a summary. The log is evidence first — an auditor asking
   * "who touched this account and what did they do" gets an answer — and a
   * proposal second: `targetRole`/`targetName` are what a later promotion into
   * artifact steps would be written from.
   */
  captureOperatorAction(interventionId: string, action: OperatorAction): void {
    const log = this.#operatorActions.get(interventionId) ?? []
    log.push(action)
    this.#operatorActions.set(interventionId, log)

    // `kind` is the evidence event's discriminant, so the action's own kind
    // travels as `action` rather than overwriting it.
    const { kind, ...rest } = action

    this.#onEvent?.({
      kind: "OperatorAction",
      sessionId: this.id,
      interventionId,
      action: kind,
      ...rest,
    })
  }

  operatorActions(interventionId: string): readonly OperatorAction[] {
    return this.#operatorActions.get(interventionId) ?? []
  }
}
