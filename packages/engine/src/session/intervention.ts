import { randomUUID } from "node:crypto"

import {
  Intervention,
  type EscalationTrigger,
  type OperatorAction,
} from "@workspace/contracts"
import { Effect } from "effect"

import type { Session } from "./session.js"

/**
 * Raising an intervention, and waiting for a person to answer it.
 *
 * The shape here is the thing worth arguing about. An escalation is *not* a
 * failure that gets reported and forgotten — it is a call that blocks, and whose
 * return value decides what the run does next. Modelling it as a request/response
 * rather than as a thrown error is what allows the design's central claim to be
 * literally true: the run pauses, a human drives, the run resumes and completes.
 *
 * The executor holds no opinion about *how* the human is reached. It calls
 * `raise` and awaits an outcome. A WebSocket console answers it today; a Slack
 * approval or an on-call page would satisfy the same interface without the
 * engine changing.
 */

export interface EscalationRequest {
  readonly runId: string
  readonly capability: string
  readonly capabilityVersion: string
  readonly tenant: string | null
  /** What the capability as a whole is trying to do. */
  readonly goal: string
  readonly stepId: string
  readonly stepIntent: string
  readonly trigger: EscalationTrigger
  readonly reason: string
  readonly screenshotRef?: string
  /** The last few things the automation did, in English. */
  readonly recentActions?: readonly string[]
}

export type EscalationOutcome =
  | {
      readonly _tag: "resume"
      readonly interventionId: string
      /**
       * `skipStep` when the operator performed the step themselves — replaying
       * it would do it twice, and in this domain "twice" is the expensive kind
       * of bug. `retryStep` when they cleared the obstruction and the automation
       * should now succeed on its own.
       */
      readonly disposition: "retryStep" | "skipStep"
      /** Who did it. Goes into the run's own trace, not just the audit log. */
      readonly by: string
      readonly operatorActions: readonly OperatorAction[]
    }
  | {
      readonly _tag: "abort"
      readonly interventionId: string
      readonly reason: string
    }

export interface Escalator {
  readonly raise: (
    request: EscalationRequest
  ) => Effect.Effect<EscalationOutcome, never>
}

interface Pending {
  intervention: Intervention
  readonly settle: (outcome: EscalationOutcome) => void
}

export interface InterventionRegistryOptions {
  readonly session: Session
  /**
   * How long to hold a run open with nobody answering. Undefined means forever,
   * which is the right default for a real queue — a paused run is not an
   * emergency, and timing out into a failure destroys the state the operator
   * needs. A CLI or a test supplies a bound.
   */
  readonly awaitTimeoutMs?: number
  readonly onEvent?: (event: Record<string, unknown>) => void
  readonly onRaised?: (intervention: Intervention) => void
  readonly onChanged?: (intervention: Intervention) => void
}

/**
 * The inbox, and the thing that unblocks a run.
 *
 * Deliberately in-memory. Interventions are operational state belonging to a
 * live browser session — an intervention that outlived the browser it refers to
 * would be an invitation to take control of a page that no longer exists. What
 * *is* durable is the evidence trail every transition writes.
 */
export class InterventionRegistry implements Escalator {
  readonly #session: Session
  readonly #pending = new Map<string, Pending>()
  readonly #options: InterventionRegistryOptions

  constructor(options: InterventionRegistryOptions) {
    this.#session = options.session
    this.#options = options
  }

  list(): readonly Intervention[] {
    return [...this.#pending.values()].map((entry) => entry.intervention)
  }

  get(id: string): Intervention | undefined {
    return this.#pending.get(id)?.intervention
  }

  raise(request: EscalationRequest): Effect.Effect<EscalationOutcome, never> {
    return Effect.promise(() => this.#raise(request))
  }

  async #raise(request: EscalationRequest): Promise<EscalationOutcome> {
    const id = `int-${randomUUID().slice(0, 8)}`

    const intervention = new Intervention({
      id,
      sessionId: this.#session.id,
      runId: request.runId,
      capability: request.capability,
      capabilityVersion: request.capabilityVersion,
      tenant: request.tenant,
      goal: request.goal,
      stepId: request.stepId,
      stepIntent: request.stepIntent,
      trigger: request.trigger,
      reason: request.reason,
      raisedAt: new Date().toISOString(),
      screenshotRef: request.screenshotRef,
      recentActions: request.recentActions ?? [],
      status: "awaiting",
    })

    /**
     * Pause in two steps, not one.
     *
     * `pauseRequested` marks the intent; `paused` says the action in flight has
     * landed. The executor only calls this once its own action has completed, so
     * the two collapse here — but the states stay distinct because the moment a
     * pause can arrive *during* an action (a stop button in the console), the
     * difference between them is the difference between a clean handover and an
     * operator inheriting a half-submitted form.
     */
    const requested = this.#session.apply({
      _tag: "pauseRequested",
      interventionId: id,
    })

    if (requested._tag === "rejected") {
      // The session is not in a state that can be paused — it was already
      // handed to someone. Aborting is the honest answer; pretending to pause
      // would leave the run waiting on an intervention nobody will see.
      return { _tag: "abort", interventionId: id, reason: requested.reason }
    }

    this.#session.apply({ _tag: "paused" })

    this.#options.onEvent?.({
      kind: "InterventionRaised",
      interventionId: id,
      sessionId: this.#session.id,
      stepId: request.stepId,
      intent: request.stepIntent,
      trigger: request.trigger,
      reason: request.reason,
      screenshotRef: request.screenshotRef,
    })

    return new Promise<EscalationOutcome>((resolve) => {
      let settled = false

      const settle = (outcome: EscalationOutcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.#pending.delete(id)
        resolve(outcome)
      }

      const timer = this.#options.awaitTimeoutMs
        ? setTimeout(() => {
            this.#options.onEvent?.({
              kind: "InterventionExpired",
              interventionId: id,
              waitedMs: this.#options.awaitTimeoutMs,
            })
            // Give the session back so it is not stranded mid-transfer.
            this.#session.apply({ _tag: "claimed", operatorId: "__timeout" })
            this.#session.apply({
              _tag: "handbackRequested",
              disposition: "abort",
            })
            this.#session.apply({ _tag: "resumed" })

            settle({
              _tag: "abort",
              interventionId: id,
              reason: `No operator responded within ${this.#options.awaitTimeoutMs}ms.`,
            })
          }, this.#options.awaitTimeoutMs)
        : undefined

      // Node should not be held open purely by a pending intervention.
      timer?.unref?.()

      this.#pending.set(id, { intervention, settle })
      this.#options.onRaised?.(intervention)
    })
  }

  /**
   * An operator takes the session.
   *
   * The state machine decides, not this method — which is why claiming an
   * already-claimed intervention returns a reason rather than silently
   * transferring the lease out from under whoever is typing.
   */
  claim(
    interventionId: string,
    operatorId: string
  ): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    const entry = this.#pending.get(interventionId)
    if (!entry) return { ok: false, reason: "No such open intervention." }

    const result = this.#session.apply({ _tag: "claimed", operatorId })
    if (result._tag === "rejected") return { ok: false, reason: result.reason }

    entry.intervention = new Intervention({
      ...entry.intervention,
      status: "claimed",
      claimedBy: operatorId,
    })

    this.#options.onEvent?.({
      kind: "InterventionClaimed",
      interventionId,
      operatorId,
    })
    this.#options.onChanged?.(entry.intervention)

    return { ok: true }
  }

  /** The operator disconnected without deciding. Back to the queue. */
  release(interventionId: string): void {
    const entry = this.#pending.get(interventionId)
    if (!entry) return

    const result = this.#session.apply({ _tag: "released" })
    if (result._tag === "rejected") return

    entry.intervention = new Intervention({
      ...entry.intervention,
      status: "awaiting",
      claimedBy: undefined,
    })

    this.#options.onEvent?.({ kind: "InterventionReleased", interventionId })
    this.#options.onChanged?.(entry.intervention)
  }

  /**
   * The operator is done. This is what unblocks the waiting run.
   *
   * The operator action log travels with the outcome, so the run's evidence
   * contains what the human did in the same trace as what the automation did —
   * one story of the run, not two systems to correlate afterwards.
   */
  resolve(
    interventionId: string,
    resolution:
      | {
          readonly _tag: "resume"
          readonly disposition: "retryStep" | "skipStep"
          readonly note?: string
        }
      | { readonly _tag: "abort"; readonly note?: string }
  ): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    const entry = this.#pending.get(interventionId)
    if (!entry) return { ok: false, reason: "No such open intervention." }

    const state = this.#session.state()
    const operatorId =
      state._tag === "OperatorDriving" || state._tag === "HandbackRequested"
        ? state.operatorId
        : undefined

    if (!operatorId) {
      return {
        ok: false,
        reason: "Nobody holds this session, so there is nothing to hand back.",
      }
    }

    const disposition =
      resolution._tag === "abort" ? "abort" : resolution.disposition

    const requested = this.#session.apply({
      _tag: "handbackRequested",
      disposition,
    })
    if (requested._tag === "rejected")
      return { ok: false, reason: requested.reason }

    this.#session.apply({ _tag: "resumed" })

    const operatorActions = this.#session.operatorActions(interventionId)
    const at = new Date().toISOString()

    entry.intervention = new Intervention({
      ...entry.intervention,
      status: "resolved",
      resolution:
        resolution._tag === "abort"
          ? { _tag: "Aborted", by: operatorId, at, note: resolution.note }
          : {
              _tag: "Resumed",
              by: operatorId,
              at,
              disposition: resolution.disposition,
              operatorActions,
              note: resolution.note,
            },
    })

    this.#options.onEvent?.({
      kind: "InterventionResolved",
      interventionId,
      operatorId,
      disposition,
      operatorActionCount: operatorActions.length,
    })
    this.#options.onChanged?.(entry.intervention)

    entry.settle(
      resolution._tag === "abort"
        ? {
            _tag: "abort",
            interventionId,
            reason: resolution.note ?? `Aborted by ${operatorId}.`,
          }
        : {
            _tag: "resume",
            interventionId,
            disposition: resolution.disposition,
            by: operatorId,
            operatorActions,
          }
    )

    return { ok: true }
  }
}
