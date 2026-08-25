import { randomUUID } from "node:crypto"

import type {
  Action,
  CapabilityArtifact,
  Observation,
  ReplayError,
  ReplayResult,
  ReplaySummary,
  Step,
  TraceEvent,
} from "@workspace/contracts"
import { decide, type AllowlistConfig } from "@workspace/policy"
import type {
  Actor,
  ControlLease,
  Surface,
  TargetHandle,
} from "@workspace/surface"
import { Effect } from "effect"

import type { EvidenceWriter } from "../evidence.js"
import type {
  EscalationOutcome,
  EscalationRequest,
  Escalator,
} from "../session/intervention.js"
import type { Session } from "../session/session.js"
import {
  resolveValueRef,
  substitute,
  substituteDescriptor,
  validateInputs,
  ValueResolutionError,
  type Bindings,
  type Vault,
} from "./bindings.js"
import { describeCondition, evaluateCondition } from "./conditions.js"

/**
 * Deterministic replay: the production execution path.
 *
 * No model is consulted. The same artifact and the same inputs take the same
 * steps in the same order, every time. Everything interesting is in how it
 * decides what just happened, because the failures that matter in this domain are
 * not layout drift — they are the ordinary exceptional states of a banking
 * application, and each one needs a *different* answer:
 *
 *   a declared outcome   → stop and tell the caller. "No such member" is an
 *                          answer, not an incident; retrying will never fix it.
 *   a recoverable state  → handle it and retry the step. The caller never hears
 *                          about the maintenance notice we dismissed.
 *   anything else        → stop with enough detail to debug without re-running.
 *
 * Those are evaluated in that order after *every* step, which is the whole
 * design. Checking the checkpoint first would report "expected the member page,
 * saw something else" for a not-found result — technically true, and useless.
 */

/** Bounded, so a recovery loop cannot become an infinite one. */
const MAX_STEP_ATTEMPTS = 3

/**
 * How many times one step may be handed to a person and come back.
 *
 * A human saying "try again" to a step that policy will refuse again is a loop
 * with a person in it, which is worse than a loop without one.
 */
const MAX_HANDBACKS_PER_STEP = 2

/** How long a step with no checkpoint is given to reveal an outcome. */
const SETTLE_MS = 750

export interface ReplayDeps {
  readonly surface: Surface
  readonly evidence: EvidenceWriter
  readonly allowlist: AllowlistConfig
  readonly lease: ControlLease
  readonly vault: Vault
  /**
   * Where a run goes when it needs a person.
   *
   * Optional, and the difference it makes is the whole of live takeover. Without
   * one, an escalation ends the run and returns `Escalated` — correct, and what
   * a headless batch replay wants. With one, `raise` *blocks*: the session is
   * handed to an operator, and the run continues from whatever they decided.
   */
  readonly escalator?: Escalator
  /**
   * The long-lived session this run is driving, when there is one.
   *
   * When present it owns the control lease and this run borrows it; when absent
   * the run takes the lease directly, which is what a one-shot CLI replay does.
   */
  readonly session?: Session
}

export interface ReplayRequest {
  readonly artifact: CapabilityArtifact
  readonly inputs: Record<string, string>
  /** Which institution's install to run against. Substituted for `{{baseUrl}}`. */
  readonly baseUrl: string
  /**
   * Capture a screenshot after every step, not only on failure.
   *
   * The difference between "the run returned TargetNotFound at s7" and being
   * able to see what the screen looked like at s5 and s6.
   */
  readonly captureSteps?: boolean
  /**
   * The id this run is already known by.
   *
   * A caller that has opened an evidence directory has *already* named the run,
   * and generating a second name here means the interventions, the trace and the
   * directory disagree about what to call the same thing — which is exactly how
   * an evidence link stops resolving. One run, one id.
   */
  readonly runId?: string
}

/** Conditions every application exhibits, whether or not an artifact declared them. */
const SESSION_EXPIRED =
  /session (has )?expired|please sign on again|log ?in again/i
const APPLICATION_ERROR =
  /unexpected (application )?error|internal server error/i

/**
 * Run a capability, and give the session back however it ends.
 *
 * The release is a wrapper rather than a line before each `return` because there
 * are a dozen ways a replay can finish and every one of them has to hand the
 * session back. A run that failed while still holding the lease would lock out
 * the operator who came to look at why.
 */
export const runReplay = (
  deps: ReplayDeps,
  request: ReplayRequest
): Effect.Effect<ReplayResult, never> =>
  executeReplay(deps, request).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        deps.session?.apply({ _tag: "runFinished" })
      })
    )
  )

const executeReplay = (
  { surface, evidence, allowlist, lease, vault, escalator, session }: ReplayDeps,
  request: ReplayRequest
): Effect.Effect<ReplayResult, never> =>
  Effect.gen(function* () {
    const { artifact, inputs, baseUrl, captureSteps = false } = request

    const runId =
      request.runId ??
      `replay-${new Date().toISOString().replace(/[:.]/g, "-")}`
    const actor: Actor = { _tag: "automation", runId }
    const startedAt = Date.now()

    const trace: TraceEvent[] = []
    const outputs: Record<string, string | number | boolean | null> = {}
    let stepsAttempted = 0

    const record = (event: TraceEvent): Effect.Effect<void, never> => {
      trace.push(event)
      return Effect.promise(() => evidence.event({ ...event }))
    }

    const summary = (): ReplaySummary => ({
      runId,
      capabilityId: artifact.id,
      capabilityVersion: artifact.version,
      tenant: artifact.target.tenant ?? null,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      stepsAttempted,
      evidenceRef: evidence.runDir,
    })

    const failed = (error: ReplayError): ReplayResult => ({
      _tag: "Failed",
      summary: summary(),
      error,
      trace,
    })

    // ── Input validation, before anything is opened or touched ───────────

    const issues = validateInputs(artifact, inputs)
    if (issues.length > 0) {
      yield* Effect.promise(() =>
        evidence.event({ kind: "InputValidationFailed", issues })
      )
      return failed({ _tag: "InputValidationFailed", issues })
    }

    const bindings: Bindings = {
      baseUrl,
      // Taken from the artifact being executed, which for a tenant-resolved
      // capability is the overlay's entry point rather than the base one.
      entryPoint: artifact.target.entryPoint,
      inputs,
      outputs,
      vault,
    }

    // A session owns its lease; a bare replay takes one. Either way the actor
    // that reaches the surface is this run and nothing else.
    if (session) session.apply({ _tag: "runStarted", runId })
    else lease.grantTo({ _tag: "automation", runId })

    yield* Effect.promise(() =>
      evidence.event({
        kind: "ReplayStarted",
        runId,
        capability: `${artifact.name}@${artifact.version}`,
        status: artifact.status,
        inputs: Object.keys(inputs),
      })
    )

    // ── Helpers ──────────────────────────────────────────────────────────

    const observe = surface
      .observe()
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)))

    /** Capture a screenshot. Only on the paths where it earns its cost. */
    const captureScreenshot = (label: string) =>
      surface.screenshot().pipe(
        Effect.flatMap((bytes) =>
          Effect.promise(() => evidence.screenshot(label, bytes))
        ),
        Effect.tap((ref) =>
          Effect.promise(() =>
            evidence.event({
              kind: "EvidenceCaptured",
              kind_: "screenshot",
              ref,
            })
          )
        ),
        Effect.catchAll(() => Effect.succeed(undefined))
      )

    const recoveryBudget = new Map<string, number>()

    // ── Escalation ───────────────────────────────────────────────────────

    type StepOutcome =
      | { readonly _tag: "acted" }
      | { readonly _tag: "stop"; readonly result: ReplayResult }
      /** A person took the session, did something, and gave it back. */
      | {
          readonly _tag: "handedBack"
          readonly disposition: "retryStep" | "skipStep"
        }

    /**
     * Stop and ask for a person.
     *
     * Two behaviours, one call site. Without an escalator the run ends here and
     * returns `Escalated` — the right answer for an unattended batch replay,
     * which has nobody to ask and should not pretend otherwise. With one, this
     * *blocks*: the session is handed over, the operator drives the same live
     * page, and what they decided comes back as the return value.
     *
     * The screenshot and the recent-action list are captured before handing over,
     * because the point of an intervention is that the person does not have to
     * reconstruct what happened.
     */
    const escalate = (
      step: Step,
      trigger: EscalationRequest["trigger"],
      reason: string
    ): Effect.Effect<StepOutcome, never> =>
      Effect.gen(function* () {
        const screenshotRef = yield* captureScreenshot(
          `intervention-${step.id}`
        )

        const recentActions = trace
          .filter(
            (event): event is Extract<TraceEvent, { _tag: "StepStarted" }> =>
              event._tag === "StepStarted"
          )
          .slice(-4)
          .map((event) => `${event.stepId}: ${event.intent}`)

        if (!escalator) {
          const interventionId = `int-${randomUUID().slice(0, 8)}`

          yield* Effect.promise(() =>
            evidence.event({
              kind: "InterventionRaised",
              interventionId,
              stepId: step.id,
              intent: step.intent,
              trigger,
              reason,
              screenshotRef,
            })
          )

          yield* record({
            _tag: "ControlHandedOver",
            stepId: step.id,
            interventionId,
            trigger,
            reason,
          })

          return {
            _tag: "stop",
            result: {
              _tag: "Escalated",
              summary: summary(),
              interventionId,
              reason,
              atStepId: step.id,
              trace,
            },
          }
        }

        const outcome: EscalationOutcome = yield* escalator.raise({
          runId,
          capability: artifact.name,
          capabilityVersion: artifact.version,
          tenant: artifact.target.tenant ?? null,
          goal: artifact.description,
          stepId: step.id,
          stepIntent: step.intent,
          trigger,
          reason,
          screenshotRef,
          recentActions,
        })

        yield* record({
          _tag: "ControlHandedOver",
          stepId: step.id,
          interventionId: outcome.interventionId,
          trigger,
          reason,
        })

        if (outcome._tag === "abort") {
          return {
            _tag: "stop",
            result: {
              _tag: "Escalated",
              summary: summary(),
              interventionId: outcome.interventionId,
              reason: outcome.reason,
              atStepId: step.id,
              trace,
            },
          }
        }

        yield* record({
          _tag: "ControlReturned",
          stepId: step.id,
          interventionId: outcome.interventionId,
          by: outcome.by,
          disposition: outcome.disposition,
          operatorActions: outcome.operatorActions.length,
        })

        return { _tag: "handedBack", disposition: outcome.disposition }
      })

    // ── Step execution ───────────────────────────────────────────────────

    /**
     * Perform one step's action. Resolution and the policy decision happen here,
     * so a refused step never reaches the surface.
     */
    const performStep = (step: Step): Effect.Effect<StepOutcome, never> =>
      Effect.gen(function* () {
        const action = step.action
        const observation = yield* observe

        const targetLabel =
          "target" in action ? action.target.description : undefined
        const url =
          action._tag === "navigate"
            ? tryResolve(action.url, bindings)
            : (observation?.url ?? baseUrl)

        const decision = decide(
          allowlist,
          {
            phase: "replay",
            maxRiskClass: artifact.policy.maxRiskClass,
            artifactApproved: artifact.status === "approved",
          },
          { kind: action._tag, url: url ?? baseUrl, targetLabel }
        )

        yield* record({
          _tag: "PolicyDecision",
          stepId: step.id,
          decision: decision._tag,
          rule: decision._tag === "Allow" ? undefined : decision.rule,
        })

        if (decision._tag === "Deny") {
          return {
            _tag: "stop",
            result: failed({
              _tag: "PolicyDenied",
              stepId: step.id,
              rule: decision.rule,
              reason: decision.reason,
            }),
          }
        }

        if (decision._tag === "RequireApproval") {
          /**
           * Not a failure. The guardrail wants a person, so the run pauses and
           * hands over the live session rather than reporting an error and
           * throwing away the state a person would need.
           *
           * Note which disposition ends this well: the operator presses the
           * irreversible button themselves and hands back `skipStep`. Answering
           * `retryStep` puts the automation back in front of a control policy
           * will refuse again — which is why handbacks per step are bounded.
           */
          return yield* escalate(
            step,
            "policyRequiresApproval",
            decision.reason
          )
        }

        // ── Resolve and act ────────────────────────────────────────────

        let handle: TargetHandle | undefined

        if ("target" in action) {
          const resolved = yield* surface
            .resolve(substituteDescriptor(action.target, bindings))
            .pipe(Effect.either)

          if (resolved._tag === "Left") {
            const error = resolved.left

            /**
             * The UI moved, and this is where a human is genuinely better than a
             * retry. Every ranked strategy has already been tried; trying them
             * again will fail identically. So when someone is available, hand
             * over — an operator who can see the screen can get the run past a
             * relabelled button in seconds, and the run still completes.
             *
             * With nobody available this stays a hard failure with the strategy
             * count intact, which is the debuggable form.
             */
            if (escalator) {
              return yield* escalate(
                step,
                error._tag === "AmbiguousTarget"
                  ? "ambiguousTarget"
                  : "targetNotFound",
                `Could not resolve "${action.target.description}" for step ${step.id}.`
              )
            }

            yield* captureScreenshot(`failure-${step.id}`)

            return {
              _tag: "stop",
              result: failed(
                error._tag === "AmbiguousTarget"
                  ? {
                      _tag: "AmbiguousTarget",
                      stepId: step.id,
                      targetDescription: action.target.description,
                      matchCount: error.matchCount,
                    }
                  : {
                      _tag: "TargetNotFound",
                      stepId: step.id,
                      targetDescription: action.target.description,
                      strategiesTried:
                        "strategiesTried" in error ? error.strategiesTried : 0,
                    }
              ),
            }
          }

          handle = resolved.right.handle

          yield* record({
            _tag: "TargetResolved",
            stepId: step.id,
            resolution: resolved.right.resolution,
          })
        }

        const began = Date.now()
        const performed = yield* runAction(step, action, handle, {
          surface,
          actor,
          bindings,
          outputs,
          artifact,
        }).pipe(Effect.either)

        if (performed._tag === "Left") {
          /**
           * Resolution can fail *inside* an action too, not only before it.
           *
           * A descriptor that resolved to a coordinate and then could not be
           * read is the same condition as one that never resolved — the UI has
           * moved — and it deserves the same answer. Missing this is why an
           * escalating run could still end as a bare `TargetNotFound`: the
           * escalation hook covered one of the two places it can happen.
           *
           * Deliberately narrow. A dead browser or an unresolvable parameter is
           * not something an operator can fix by looking at the screen, so those
           * stay hard failures.
           */
          const kind = performed.left._tag

          if (
            escalator &&
            (kind === "TargetNotFound" || kind === "AmbiguousTarget")
          ) {
            return yield* escalate(
              step,
              kind === "AmbiguousTarget" ? "ambiguousTarget" : "targetNotFound",
              `Step ${step.id} could not act on its target: ${kind}.`
            )
          }

          yield* captureScreenshot(`failure-${step.id}`)
          return { _tag: "stop", result: failed(performed.left) }
        }

        yield* record({
          _tag: "ActionPerformed",
          stepId: step.id,
          action: action._tag,
          durationMs: Date.now() - began,
        })

        return { _tag: "acted" }
      })

    // ── Detection, in priority order ─────────────────────────────────────

    type Detection =
      | { readonly _tag: "outcome"; readonly result: ReplayResult }
      | { readonly _tag: "recover"; readonly recovery: string }
      | { readonly _tag: "ok" }
      | { readonly _tag: "fail"; readonly error: ReplayError }

    /**
     * Wait for the step to settle, then say what happened.
     *
     * The checkpoint *is* the wait. An action that navigates has not finished
     * when `act` returns — the response is still in flight — so evaluating once
     * would report "expected the member page, saw the search form" for a step
     * that was about to succeed. Polling the condition until it holds means the
     * artifact never carries a sleep, and a page that loads in 40ms costs 40ms
     * rather than a hard-coded second.
     *
     * Outcomes and recoveries are re-checked on every pass for the same reason:
     * a "no such member" result arrives on the same navigation the checkpoint is
     * waiting for.
     *
     * Steps with no checkpoint get a short settle window instead of the full
     * timeout — long enough to notice an outcome, short enough not to add
     * seconds to a run. It is also a standing argument for recording a
     * checkpoint on every step.
     */
    const settle = (step: Step): Effect.Effect<Detection, never> =>
      Effect.gen(function* () {
        const deadline =
          Date.now() + (step.checkpoint ? step.timeoutMs : SETTLE_MS)
        let lastDetail = "nothing was observed"

        while (true) {
          const observation = yield* observe

          if (!observation) {
            return {
              _tag: "fail",
              error: {
                _tag: "SurfaceUnavailable",
                stepId: step.id,
                detail: "could not read the surface",
              },
            }
          }

          const context = { observation, surface, bindings }

          // 1. A declared business outcome. Checked first, because it is an
          //    answer and every other reading of this screen would be wrong.
          for (const outcome of artifact.outcomes) {
            const result = yield* evaluateCondition(outcome.detect, context)
            if (!result.passed) continue

            yield* record({
              _tag: "OutcomeDetected",
              stepId: step.id,
              outcome: outcome.tag,
            })

            return {
              _tag: "outcome",
              result: {
                _tag: "BusinessOutcome",
                summary: summary(),
                outcome: outcome.tag,
                detail: outcome.description,
                atStepId: step.id,
                outputs,
                trace,
              },
            }
          }

          // 2. A recoverable condition the artifact declared.
          for (const recovery of artifact.recoveries) {
            const result = yield* evaluateCondition(recovery.when, context)
            if (!result.passed) continue

            const used = recoveryBudget.get(recovery.name) ?? 0
            if (used >= recovery.maxPerRun) {
              return {
                _tag: "fail",
                error: {
                  _tag: "CheckpointFailed",
                  stepId: step.id,
                  expected: `recovery "${recovery.name}" to clear the condition`,
                  observed: `it fired ${used} times and the condition is still present`,
                },
              }
            }

            recoveryBudget.set(recovery.name, used + 1)

            yield* record({
              _tag: "RecoveryApplied",
              stepId: step.id,
              recovery: recovery.name,
              attempt: used + 1,
            })

            if (recovery.retriesStep) {
              // Context was lost; the outer loop has to perform the step again.
              return { _tag: "recover", recovery: recovery.name }
            }

            // Obstruction cleared. Keep waiting for the checkpoint the step was
            // already on its way to satisfying.
            for (const action of recovery.do) {
              yield* applyRecoveryAction(action, { surface, actor, bindings })
            }
            continue
          }

          // 3. Built-in surface signals: states every application in this class
          //    exhibits, which an artifact should not have to declare to survive.
          const text = observationText(observation)

          if (SESSION_EXPIRED.test(text)) {
            const used = recoveryBudget.get("__session") ?? 0
            if (used >= 1) {
              return {
                _tag: "fail",
                error: {
                  _tag: "SessionExpiredUnrecoverable",
                  stepId: step.id,
                  reauthAttempts: used,
                },
              }
            }
            recoveryBudget.set("__session", used + 1)
            return { _tag: "recover", recovery: "__session" }
          }

          if (
            (observation.httpStatus ?? 200) >= 500 ||
            APPLICATION_ERROR.test(text)
          ) {
            return {
              _tag: "fail",
              error: {
                _tag: "ApplicationError",
                stepId: step.id,
                detail: `the application reported an error (http ${observation.httpStatus ?? "?"})`,
              },
            }
          }

          // 4. The step's own checkpoint.
          if (step.checkpoint) {
            const result = yield* evaluateCondition(step.checkpoint, context)

            if (result.passed) {
              yield* record({ _tag: "CheckpointPassed", stepId: step.id })
              return { _tag: "ok" }
            }

            lastDetail = result.detail
          }

          if (Date.now() >= deadline) {
            return step.checkpoint
              ? {
                  _tag: "fail",
                  error: {
                    _tag: "CheckpointFailed",
                    stepId: step.id,
                    expected: describeCondition(step.checkpoint),
                    observed: lastDetail,
                  },
                }
              : { _tag: "ok" }
          }

          yield* Effect.sleep("100 millis")
        }
      })

    /** Re-establish a session by replaying the artifact's own sign-on steps. */
    const reauthenticate = Effect.gen(function* () {
      const signOn = artifact.steps.slice(0, indexOfFirstNonAuthStep(artifact))
      yield* Effect.promise(() =>
        evidence.event({
          kind: "RecoveryApplied",
          recovery: "reauthenticate",
          steps: signOn.length,
        })
      )

      for (const step of signOn) {
        yield* performStep(step)
      }
    })

    // ── Main loop ────────────────────────────────────────────────────────

    if (artifact.steps[0]?.action._tag !== "navigate") {
      const entry = substitute(artifact.target.entryPoint, bindings)
      yield* surface
        .act(actor, { _tag: "navigate", url: entry })
        .pipe(Effect.either)
    }

    for (const step of artifact.steps) {
      stepsAttempted += 1

      yield* record({
        _tag: "StepStarted",
        stepId: step.id,
        intent: step.intent,
        at: new Date().toISOString(),
      })

      let attempt = 0
      let settled = false

      /**
       * After restoring context we re-check before re-acting.
       *
       * Re-authenticating replays the capability's own sign-on prelude, which may
       * already have accomplished the very step that was interrupted — a session
       * that expired *during* sign-on comes back already signed on, and clicking
       * "Sign On" again would look for a button that is no longer there. So the
       * checkpoint is consulted first, and the action is only repeated if the
       * step genuinely did not take effect.
       */
      let skipAction = false
      let justRecovered = false
      let handbacks = 0

      while (!settled) {
        attempt += 1

        if (attempt > MAX_STEP_ATTEMPTS) {
          yield* captureScreenshot(`failure-${step.id}`)
          return failed({
            _tag: "StepTimeout",
            stepId: step.id,
            waitedMs: Date.now() - startedAt,
          })
        }

        if (!skipAction) {
          const performed = yield* performStep(step)
          if (performed._tag === "stop") return performed.result

          if (performed._tag === "handedBack") {
            handbacks += 1

            if (handbacks > MAX_HANDBACKS_PER_STEP) {
              return {
                _tag: "Escalated",
                summary: summary(),
                interventionId: `int-exhausted-${step.id}`,
                reason:
                  `Step ${step.id} was handed to an operator ` +
                  `${handbacks - 1} times and still cannot proceed.`,
                atStepId: step.id,
                trace,
              }
            }

            if (performed.disposition === "retryStep") {
              // A person cleared whatever blocked the step, so the automation
              // starts from a genuinely different world. Giving the step its
              // attempt budget back is the point of having asked.
              attempt = 0
              continue
            }

            /**
             * `skipStep`: the operator did this step by hand. The action is not
             * repeated — but the checkpoint still runs. Trusting a human's word
             * that the screen is where it should be is exactly the assumption
             * the checkpoint exists to remove, and it is no more warranted here
             * than for the automation.
             */
          }
        }
        skipAction = false

        const detection = yield* settle(step)

        switch (detection._tag) {
          case "outcome":
            return detection.result

          case "recover": {
            if (detection.recovery === "__session") {
              yield* record({
                _tag: "RecoveryApplied",
                stepId: step.id,
                recovery: detection.recovery,
                attempt,
              })
              yield* reauthenticate
            } else {
              const recovery = artifact.recoveries.find(
                (r) => r.name === detection.recovery
              )
              for (const action of recovery?.do ?? []) {
                yield* applyRecoveryAction(action, { surface, actor, bindings })
              }
            }
            // Only recoveries that restore lost context reach here. Re-check
            // before re-acting; the next pass acts only if it is still failing.
            skipAction = true
            justRecovered = true
            break
          }

          case "fail":
            if (justRecovered) {
              // The recovery did not, by itself, satisfy the step — so perform
              // it again rather than reporting a failure the retry would fix.
              justRecovered = false
              break
            }
            yield* captureScreenshot(`failure-${step.id}`)
            return failed(detection.error)

          case "ok":
            /**
             * A frame of the run, when the caller asked for one.
             *
             * Off by default because a screenshot per step roughly doubles a
             * replay's wall time, and an unattended job running a thousand times
             * a day should not pay that to produce images nobody opens. On by
             * choice, it turns a two-second run — over before anyone can watch
             * it — into something a person can actually look through afterwards.
             */
            if (captureSteps) yield* captureScreenshot(`step-${step.id}`)
            settled = true
            break
        }
      }
    }

    // ── Did it actually work? ────────────────────────────────────────────

    const finalObservation = yield* observe
    if (finalObservation) {
      const success = yield* evaluateCondition(artifact.successCondition, {
        observation: finalObservation,
        surface,
        bindings,
      })

      if (!success.passed) {
        yield* captureScreenshot("failure-success-condition")
        return failed({
          _tag: "CheckpointFailed",
          stepId: artifact.steps.at(-1)?.id ?? "success",
          expected: describeCondition(artifact.successCondition),
          observed: success.detail,
        })
      }
    }

    yield* Effect.promise(() =>
      evidence.event({
        kind: "ReplayFinished",
        result: "Succeeded",
        outputs: Object.keys(outputs),
      })
    )

    return { _tag: "Succeeded", summary: summary(), outputs, trace }
  })

// ── Action execution ───────────────────────────────────────────────────

interface ActionContext {
  readonly surface: Surface
  readonly actor: Actor
  readonly bindings: Bindings
  readonly outputs: Record<string, string | number | boolean | null>
  readonly artifact: CapabilityArtifact
}

const tryResolve = (
  ref: Parameters<typeof resolveValueRef>[0],
  bindings: Bindings
): string | undefined => {
  try {
    return resolveValueRef(ref, bindings)
  } catch {
    return undefined
  }
}

const runAction = (
  step: Step,
  action: Action,
  handle: TargetHandle | undefined,
  context: ActionContext
): Effect.Effect<void, ReplayError> =>
  Effect.gen(function* () {
    const { surface, actor, bindings, outputs, artifact } = context

    const resolve = (ref: Parameters<typeof resolveValueRef>[0]) =>
      Effect.try({
        try: () => resolveValueRef(ref, bindings),
        catch: (cause): ReplayError => ({
          _tag: "InputValidationFailed",
          issues: [
            cause instanceof ValueResolutionError
              ? cause.message
              : `Could not resolve a value for step ${step.id}.`,
          ],
        }),
      })

    const act = (command: Parameters<Surface["act"]>[1]) =>
      surface.act(actor, command).pipe(
        Effect.mapError(
          (error): ReplayError => ({
            _tag: "SurfaceUnavailable",
            stepId: step.id,
            detail: error._tag,
          })
        )
      )

    switch (action._tag) {
      case "navigate":
        return yield* act({ _tag: "navigate", url: yield* resolve(action.url) })

      case "press":
        return yield* act({ _tag: "press", key: action.key })

      case "click":
        if (!handle) return
        return yield* act({ _tag: "click", handle })

      case "type": {
        if (!handle) return
        const text = yield* resolve(action.value)
        return yield* act({
          _tag: "type",
          handle,
          text,
          clearFirst: action.clearFirst,
        })
      }

      case "select": {
        if (!handle) return
        const value = yield* resolve(action.value)
        return yield* act({ _tag: "select", handle, value })
      }

      case "extract": {
        if (!handle) return

        const raw = yield* surface.read(handle).pipe(
          Effect.mapError(
            (): ReplayError => ({
              _tag: "TargetNotFound",
              stepId: step.id,
              targetDescription: action.target.description,
              strategiesTried: 0,
            })
          )
        )

        const declared = artifact.outputs.find(
          (output) => output.name === action.output
        )
        outputs[action.output] = coerce(raw, declared?.type ?? "string")
        return
      }

      case "waitFor":
        // Waiting is expressed as a condition and handled by the retry loop.
        return

      case "reauth":
        return
    }
  })

const applyRecoveryAction = (
  action: Action,
  context: { surface: Surface; actor: Actor; bindings: Bindings }
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const { surface, actor, bindings } = context

    if (action._tag === "navigate") {
      const url = tryResolve(action.url, bindings)
      if (url)
        yield* surface.act(actor, { _tag: "navigate", url }).pipe(Effect.either)
      return
    }

    if (!("target" in action)) return

    const resolved = yield* surface
      .resolve(substituteDescriptor(action.target, bindings))
      .pipe(Effect.either)
    if (resolved._tag === "Left") return

    if (action._tag === "click") {
      yield* surface
        .act(actor, { _tag: "click", handle: resolved.right.handle })
        .pipe(Effect.either)
    }
  })

// ── Helpers ────────────────────────────────────────────────────────────

const observationText = (observation: Observation): string =>
  observation.frames
    .flatMap((frame) => frame.nodes.map((node) => node.text ?? node.name))
    .join(" ")

/**
 * Coerce an extracted string into the type the capability's contract promised.
 *
 * The declared `type` wins over the format hint: it is what the calling agent was
 * told to expect, and quietly returning a number where the contract says string
 * is the same class of bug as returning the wrong shape from an API.
 */
const coerce = (raw: string, type: "string" | "number" | "boolean") => {
  const text = raw.trim()

  if (type === "number") {
    const numeric = Number(text.replace(/[^0-9.-]/g, ""))
    return Number.isFinite(numeric) ? numeric : null
  }

  if (type === "boolean") return /^(true|yes|y|1)$/i.test(text)

  return text
}

/**
 * Where the sign-on prelude ends.
 *
 * Re-authentication replays the artifact's own opening steps rather than a
 * separate hard-coded login, so a capability recorded against a different sign-on
 * screen recovers correctly without anyone teaching the engine about it.
 */
const indexOfFirstNonAuthStep = (artifact: CapabilityArtifact): number => {
  const index = artifact.steps.findIndex((step) =>
    "value" in step.action ? step.action.value._tag === "param" : false
  )
  return index > 0 ? index : Math.min(4, artifact.steps.length)
}
