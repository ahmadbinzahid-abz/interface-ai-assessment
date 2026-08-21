import type {
  Action,
  Condition,
  Observation,
  ValueFormat,
  ValueRef,
} from "@workspace/contracts"
import {
  decide,
  type AllowlistConfig,
  type PolicyDecision,
} from "@workspace/policy"
import type {
  Actor,
  ControlLease,
  Surface,
  TargetHandle,
} from "@workspace/surface"
import { Effect } from "effect"

import type { EvidenceWriter } from "../evidence.js"
import type { ModelClient, ModelToolResult } from "../model.js"
import { synthesizeDescriptor } from "./descriptor.js"
import { buildOpeningMessage, buildSystemPrompt } from "./prompt.js"
import {
  findControl,
  renderObservation,
  type RenderedObservation,
} from "./render.js"
import { discoveryTools } from "./tools.js"
import type {
  DiscoveryParameter,
  DiscoveryResult,
  DiscoveryRun,
  RecordedOutcome,
  RecordedOutput,
  RecordedStep,
} from "./types.js"

/**
 * The observe → decide → act loop.
 *
 * Three things about its shape are deliberate.
 *
 * **Every action passes through policy before it reaches the surface**, and a
 * refusal is returned to the model as an ordinary tool result. That matters:
 * page content is untrusted input, so a model can be talked into anything, and
 * the only durable defence is that the decision to permit an action is made
 * somewhere the model cannot reach. Telling it *why* it was refused is what lets
 * it escalate rather than thrash.
 *
 * **The recording is a by-product of acting, not a separate pass.** Each
 * permitted action is compiled into a durable step at the moment it happens,
 * from the observation it happened against. Reconstructing steps afterwards from
 * a transcript is where fidelity gets lost.
 *
 * **Only one page-changing action runs per turn.** Control references are
 * renumbered whenever the screen changes, so a second call in the same turn is
 * pointing at a screen that no longer exists. Refusing it and saying so is
 * safer than acting on a stale reference.
 */

export interface DiscoveryDeps {
  readonly surface: Surface
  readonly model: ModelClient
  readonly evidence: EvidenceWriter
  readonly allowlist: AllowlistConfig
  /**
   * Control of the session. The run acquires it under its own id rather than
   * trusting a caller to have granted it to the right actor — a lease held by
   * some *other* run looks exactly like an operator holding it, and every action
   * would be refused for a reason that has nothing to do with the guardrail.
   */
  readonly lease: ControlLease
}

export interface DiscoveryRequest {
  readonly goal: string
  readonly entryPoint: string
  readonly parameters: readonly DiscoveryParameter[]
  readonly maxTurns?: number
  readonly maxWallClockMs?: number
}

const CHANGES_SCREEN = new Set(["navigate", "click", "type", "select"])

/** How long to wait for the screen to stop changing before reading it. */
const SETTLE_TIMEOUT_MS = 3_000

export const runDiscovery = (
  { surface, model, evidence, allowlist, lease }: DiscoveryDeps,
  request: DiscoveryRequest
): Effect.Effect<DiscoveryRun, never> =>
  Effect.gen(function* () {
    const runId = `discovery-${new Date().toISOString().replace(/[:.]/g, "-")}`
    const actor: Actor = { _tag: "automation", runId }
    const startedAt = Date.now()

    // Take the session. Phase 5's handoff hands it to an operator and back.
    lease.grantTo({ _tag: "automation", runId })

    const maxTurns = request.maxTurns ?? 30
    const maxWallClockMs = request.maxWallClockMs ?? 5 * 60_000

    const steps: RecordedStep[] = []
    const outputs: RecordedOutput[] = []
    const outcomes: RecordedOutcome[] = []

    let stepCounter = 0
    let turns = 0
    let finish: DiscoveryResult | undefined

    /**
     * Repetition counter, keyed by what the action actually was.
     *
     * A model that cannot make progress does not stop — it tries the same thing
     * again, and on a metered API that is expensive as well as useless. Counting
     * identical actions is the cheapest honest definition of "stuck", and it is
     * the same signal that routes an intervention to a human in replay.
     */
    const attempts = new Map<string, number>()
    const REPEAT_LIMIT = 3

    /**
     * Trace writes started from synchronous code. Awaited at the end of each turn
     * so the file stays in order — appending concurrently would interleave lines.
     */
    const pendingEvents: Promise<void>[] = []
    const flushEvents = Effect.promise(async () => {
      await Promise.all(pendingEvents.splice(0))
    })

    yield* Effect.promise(() =>
      evidence.event({
        kind: "RunStarted",
        runId,
        goal: request.goal,
        model: model.id,
      })
    )

    // ── Helpers ────────────────────────────────────────────────────────────

    const observeOnce = Effect.gen(function* () {
      const observation = yield* surface
        .observe()
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      if (!observation) return undefined
      return { observation, rendered: renderObservation(observation) }
    })

    /**
     * Observe once the screen has stopped changing.
     *
     * An action that navigates has not finished when `act` returns, so reading
     * immediately shows the model the page it was just on — which is both
     * confusing to the model and a source of flaky recordings. Rather than
     * sleeping a fixed amount, the view is read until two consecutive reads
     * agree, which costs nothing on a page that is already still.
     */
    const observeAndRender = Effect.gen(function* () {
      const deadline = Date.now() + SETTLE_TIMEOUT_MS
      let previous = yield* observeOnce

      while (Date.now() < deadline) {
        yield* Effect.sleep("120 millis")
        const current = yield* observeOnce

        if (
          current &&
          previous &&
          current.rendered.text === previous.rendered.text
        ) {
          return current
        }

        previous = current
      }

      return previous
    })

    /**
     * Record a step and write it to the trace.
     *
     * The trace has to carry the *intent*, not just the fact that policy allowed
     * something. "Allowed a click on Search" does not tell an investigator
     * anything; "Clicked Search to find the member details, resolved at rank 1"
     * does. The resolution rank is included for the same reason — it is where
     * drift first becomes visible.
     */
    const record = (step: Omit<RecordedStep, "id">): RecordedStep => {
      stepCounter += 1
      const recorded: RecordedStep = { id: `s${stepCounter}`, ...step }
      steps.push(recorded)

      pendingEvents.push(
        evidence.event({
          kind: "StepRecorded",
          stepId: recorded.id,
          intent: recorded.intent,
          action: recorded.action._tag,
          riskClass: recorded.riskClass,
          resolvedAtRank: recorded.resolvedAtRank,
          exploratory: recorded.exploratory ?? false,
          checkpoint: recorded.checkpoint?._tag,
        })
      )

      return recorded
    }

    /**
     * A value the model typed is recorded as a parameter reference when it
     * matches a declared task input. That single substitution is what makes the
     * artifact reusable — and it is also what keeps the member's real number out
     * of a file we commit.
     */
    const asValueRef = (value: string): ValueRef =>
      literalOrParam(value, request.parameters)

    const checkpointFor = (expect: unknown): Condition | undefined =>
      typeof expect === "string" && expect.trim().length > 0
        ? { _tag: "textPresent", text: expect.trim() }
        : undefined

    const policyResult = (
      decision: PolicyDecision,
      action: string
    ): Record<string, unknown> => ({
      ok: false,
      refused: true,
      rule: decision._tag === "Allow" ? undefined : decision.rule,
      reason: decision._tag === "Allow" ? undefined : decision.reason,
      hint: `The policy engine refused this ${action}. Do not look for another way to do the same thing. If the task needs it, call escalate.`,
    })

    // ── Session ────────────────────────────────────────────────────────────

    const initial = yield* observeAndRender
    let view: RenderedObservation = initial?.rendered ?? {
      text: "(the surface could not be read)",
      controls: [],
    }
    let current: Observation | undefined = initial?.observation

    const session = yield* Effect.promise(() =>
      model.startSession({ system: buildSystemPrompt(), tools: discoveryTools })
    )

    let turn = yield* Effect.promise(() =>
      session.send({
        _tag: "text",
        text: buildOpeningMessage({
          goal: request.goal,
          entryPoint: request.entryPoint,
          parameters: request.parameters,
          view: view.text,
        }),
      })
    )

    // ── Loop ───────────────────────────────────────────────────────────────

    while (!finish) {
      turns += 1

      if (turns > maxTurns) {
        finish = {
          _tag: "Exhausted",
          reason: `Stopped after ${maxTurns} turns.`,
        }
        break
      }

      if (Date.now() - startedAt > maxWallClockMs) {
        finish = {
          _tag: "Exhausted",
          reason: `Stopped after ${maxWallClockMs}ms.`,
        }
        break
      }

      if (turn.calls.length === 0) {
        // The model replied with prose instead of acting. Nudge once per turn;
        // the turn cap stops this becoming a conversation.
        turn = yield* Effect.promise(() =>
          session.send({
            _tag: "text",
            text: "Call a tool to continue, or call escalate or give_up if you cannot proceed.",
          })
        )
        continue
      }

      const results: ModelToolResult[] = []
      let screenChanged = false

      for (const call of turn.calls) {
        if (screenChanged && CHANGES_SCREEN.has(call.name)) {
          results.push({
            id: call.id,
            name: call.name,
            response: {
              ok: false,
              reason:
                "The screen already changed earlier in this turn, so control numbers are stale. " +
                "Look at the new screen below and act again.",
            },
          })
          continue
        }

        const outcome = yield* handleCall({
          call,
          view,
          current,
          observeAfter: observeAndRender,
          surface,
          actor,
          allowlist,
          evidence,
          parameters: request.parameters,
          record,
          outputs,
          outcomes,
          asValueRef,
          checkpointFor,
          policyResult,
        })

        if (outcome.terminal) finish = outcome.terminal
        if (outcome.changedScreen) screenChanged = true

        if (outcome.fingerprint) {
          const seen = (attempts.get(outcome.fingerprint) ?? 0) + 1
          attempts.set(outcome.fingerprint, seen)

          if (seen > REPEAT_LIMIT) {
            yield* Effect.promise(() =>
              evidence.event({
                kind: "StuckDetected",
                action: outcome.fingerprint,
                attempts: seen,
              })
            )
            finish = {
              _tag: "Exhausted",
              reason:
                `No progress: "${outcome.fingerprint}" was attempted ${seen} times. ` +
                "In production this routes an intervention to a human operator.",
            }
          }
        }

        results.push({
          id: call.id,
          name: call.name,
          response: outcome.response,
        })

        if (outcome.terminal) break
      }

      if (finish) break

      yield* flushEvents

      const refreshed = yield* observeAndRender
      if (refreshed) {
        current = refreshed.observation
        view = refreshed.rendered
      }

      const withView = results.map((result, index) =>
        index === results.length - 1
          ? { ...result, response: { ...result.response, screen: view.text } }
          : result
      )

      turn = yield* Effect.promise(() =>
        session.send({ _tag: "toolResults", results: withView })
      )
    }

    yield* flushEvents

    const run: DiscoveryRun = {
      runId,
      result: finish ?? {
        _tag: "Exhausted",
        reason: "Loop ended without a result.",
      },
      steps,
      outputs,
      outcomes,
      modelId: model.id,
      turns,
      durationMs: Date.now() - startedAt,
    }

    yield* Effect.promise(() =>
      evidence.event({
        kind: "RunFinished",
        result: run.result._tag,
        steps: steps.length,
        turns,
        durationMs: run.durationMs,
      })
    )

    return run
  })

// ── Tool dispatch ────────────────────────────────────────────────────────

interface CallOutcome {
  readonly response: Record<string, unknown>
  readonly changedScreen?: boolean
  readonly terminal?: DiscoveryResult
  /** Identity of the attempted action, for repetition detection. */
  readonly fingerprint?: string
}

interface HandleCallArgs {
  readonly call: {
    readonly name: string
    readonly args: Record<string, unknown>
  }
  readonly view: RenderedObservation
  readonly current: Observation | undefined
  /** Re-read the screen once it has settled, to check what the step claimed. */
  readonly observeAfter: Effect.Effect<
    { observation: Observation; rendered: RenderedObservation } | undefined,
    never
  >
  readonly surface: Surface
  readonly actor: Actor
  readonly allowlist: AllowlistConfig
  readonly evidence: EvidenceWriter
  readonly parameters: readonly DiscoveryParameter[]
  readonly record: (step: Omit<RecordedStep, "id">) => RecordedStep
  readonly outputs: RecordedOutput[]
  readonly outcomes: RecordedOutcome[]
  readonly asValueRef: (value: string) => ValueRef
  readonly checkpointFor: (expect: unknown) => Condition | undefined
  readonly policyResult: (
    decision: PolicyDecision,
    action: string
  ) => Record<string, unknown>
}

const handleCall = (args: HandleCallArgs): Effect.Effect<CallOutcome, never> =>
  Effect.gen(function* () {
    const {
      call,
      view,
      current,
      observeAfter,
      surface,
      actor,
      allowlist,
      evidence,
      record,
      outputs,
      outcomes,
      asValueRef,
      checkpointFor,
      policyResult,
    } = args

    const pageUrl = current?.url ?? ""

    switch (call.name) {
      case "observe":
        return { response: { ok: true } }

      case "escalate":
        return {
          response: { ok: true, acknowledged: true },
          terminal: {
            _tag: "Escalated",
            reason: String(call.args["reason"] ?? "unspecified"),
          },
        }

      case "give_up":
        return {
          response: { ok: true, acknowledged: true },
          terminal: {
            _tag: "GaveUp",
            reason: String(call.args["reason"] ?? "unspecified"),
          },
        }

      case "finish":
        return {
          response: { ok: true, acknowledged: true },
          terminal: {
            _tag: "Completed",
            summary: String(call.args["summary"] ?? ""),
            successText: String(call.args["successText"] ?? ""),
          },
        }

      case "declare_outcome": {
        const outcome: RecordedOutcome = {
          tag: String(call.args["tag"] ?? "Unknown"),
          description: String(call.args["description"] ?? ""),
          whenText: String(call.args["whenText"] ?? ""),
        }
        outcomes.push(outcome)
        yield* Effect.promise(() =>
          evidence.event({ kind: "OutcomeDeclared", ...outcome })
        )
        return { response: { ok: true, declared: outcome.tag } }
      }

      case "navigate": {
        const url = String(call.args["url"] ?? "")
        const decision = decide(
          allowlist,
          { phase: "discovery", maxRiskClass: "safe" },
          {
            kind: "navigate",
            url,
          }
        )

        yield* Effect.promise(() =>
          evidence.event({
            kind: "PolicyDecision",
            action: "navigate",
            url,
            decision: decision._tag,
          })
        )

        if (decision._tag !== "Allow")
          return { response: policyResult(decision, "navigation") }

        const acted = yield* surface
          .act(actor, { _tag: "navigate", url })
          .pipe(Effect.either)

        if (acted._tag === "Left") {
          return {
            response: {
              ok: false,
              reason: `Navigation failed: ${acted.left._tag}`,
            },
          }
        }

        record({
          intent: String(call.args["why"] ?? "Navigate to the entry point"),
          action: { _tag: "navigate", url: asValueRef(url) },
          riskClass: "safe",
          checkpoint: checkpointFor(call.args["expect"]) ?? {
            _tag: "urlMatches",
            pattern: escapeRegExp(url),
          },
          observedMs: 0,
        })

        return {
          response: { ok: true },
          changedScreen: true,
          fingerprint: `navigate:${url}`,
        }
      }

      case "click":
      case "type":
      case "select":
      case "extract": {
        const ref = Number(call.args["ref"])
        const control = findControl(view, ref)

        if (!control || !current) {
          return {
            response: {
              ok: false,
              reason: `There is no control #${ref} on the current screen. Look at the screen again.`,
            },
            // Counted too: a model reaching for a control that is not there,
            // over and over, is exactly as stuck as one clicking the wrong button.
            fingerprint: `${call.name}:missing-ref-${ref}`,
          }
        }

        const label = control.name || control.label || control.role
        const kind = call.name as "click" | "type" | "select" | "extract"

        const decision = decide(
          allowlist,
          { phase: "discovery", maxRiskClass: "safe" },
          { kind, url: pageUrl, targetLabel: label }
        )

        yield* Effect.promise(() =>
          evidence.event({
            kind: "PolicyDecision",
            action: kind,
            target: label,
            decision: decision._tag,
            rule: decision._tag === "Allow" ? undefined : decision.rule,
          })
        )

        if (decision._tag !== "Allow")
          return { response: policyResult(decision, kind) }

        const descriptorBase = {
          observation: current,
          framePath: control.framePath,
          node: control.node,
          // Reading a cell for its value must not identify it *by* that value.
          identifiesByValue: kind === "extract",
          description:
            kind === "extract"
              ? // Named for what it yields, not for what it currently says: the
                // value is the answer and will differ on the next invocation.
                `${control.role} holding ${String(call.args["output"] ?? "the value")}`
              : control.name
                ? `${control.role} "${control.name}"`
                : control.label
                  ? `${control.role} labelled "${control.label}"`
                  : `${control.role} #${ref}`,
        }

        // Resolve through the real ranked pipeline rather than acting on the raw
        // node: the step must be proven to work the way replay will run it.
        const draft = synthesizeDescriptor(descriptorBase)
        const resolved = yield* surface.resolve(draft).pipe(Effect.either)

        if (resolved._tag === "Left") {
          return {
            response: {
              ok: false,
              reason:
                `Could not reliably target that control (${resolved.left._tag}). ` +
                `Try a different control, or escalate.`,
            },
          }
        }

        const handle: TargetHandle = resolved.right.handle
        const detail = yield* surface
          .describe(handle)
          .pipe(
            Effect.catchAll(() =>
              Effect.succeed({ attributes: {} as Record<string, string> })
            )
          )

        // Re-synthesise now that the platform details are known, so the recorded
        // descriptor carries its ranked fallbacks.
        const descriptor = synthesizeDescriptor({
          ...descriptorBase,
          attributes: detail.attributes,
          bounds: "bounds" in detail ? detail.bounds : undefined,
          viewport: "viewport" in detail ? detail.viewport : undefined,
        })

        const startedAt = Date.now()

        if (kind === "extract") {
          const text = yield* surface.read(handle).pipe(Effect.either)
          if (text._tag === "Left") {
            return {
              response: { ok: false, reason: "Could not read that control." },
            }
          }

          const output: RecordedOutput = {
            name: String(call.args["output"] ?? "value"),
            format: (call.args["format"] as ValueFormat | undefined) ?? "text",
            description: String(call.args["description"] ?? ""),
            sampleValue: text.right.trim(),
          }
          outputs.push(output)

          record({
            intent: String(call.args["why"] ?? `Read ${output.name}`),
            action: {
              _tag: "extract",
              target: descriptor,
              output: output.name,
              as: output.format,
            },
            riskClass: "safe",
            observedMs: Date.now() - startedAt,
            resolvedAtRank: resolved.right.resolution.rank,
          })

          return {
            response: {
              ok: true,
              output: output.name,
              value: output.sampleValue,
            },
            fingerprint: `extract:${output.name}`,
          }
        }

        const value = String(call.args["value"] ?? "")

        const command =
          kind === "click"
            ? ({ _tag: "click", handle } as const)
            : kind === "type"
              ? ({
                  _tag: "type",
                  handle,
                  text: value,
                  clearFirst: true,
                } as const)
              : ({ _tag: "select", handle, value } as const)

        const acted = yield* surface.act(actor, command).pipe(Effect.either)

        if (acted._tag === "Left") {
          return {
            response: {
              ok: false,
              reason: `The ${kind} failed: ${acted.left._tag}`,
            },
          }
        }

        const action: Action =
          kind === "click"
            ? { _tag: "click", target: descriptor }
            : kind === "type"
              ? {
                  _tag: "type",
                  target: descriptor,
                  value: asValueRef(value),
                  clearFirst: true,
                }
              : { _tag: "select", target: descriptor, value: asValueRef(value) }

        /**
         * Check the model's expectation against the screen it actually produced.
         *
         * A model will confidently name a heading that does not exist — one real
         * run expected "Savings Balance" on a page whose column reads "Current
         * Balance". Recording that as a checkpoint bakes a guaranteed failure
         * into the capability, and the failure surfaces much later, in
         * production, looking like drift.
         *
         * So an expectation that is not visible right now is not recorded, and
         * the model is told, which gives it the chance to supply a real one.
         */
        const after = yield* observeAfter
        const expected = call.args["expect"]
        const expectedText =
          typeof expected === "string" && expected.trim().length > 0
            ? expected.trim()
            : undefined

        const expectationHolds =
          expectedText === undefined ||
          (after?.rendered.text ?? "")
            .toLowerCase()
            .includes(expectedText.toLowerCase())

        record({
          intent: String(call.args["why"] ?? `${kind} ${label}`),
          action,
          riskClass: decision.riskClass,
          checkpoint: expectationHolds ? checkpointFor(expected) : undefined,
          observedMs: Date.now() - startedAt,
          resolvedAtRank: resolved.right.resolution.rank,
          exploratory: call.args["exploratory"] === true,
        })

        return {
          response: expectationHolds
            ? { ok: true }
            : {
                ok: true,
                warning:
                  `The step worked, but "${expectedText}" is not on the resulting screen, so it ` +
                  "was not recorded as a check. Look at the screen below and, if this step needs " +
                  "verifying, name something that is actually there.",
              },
          changedScreen: true,
          fingerprint: `${kind}:${label}:${value}`,
        }
      }

      default:
        return {
          response: { ok: false, reason: `Unknown tool "${call.name}".` },
        }
    }
  })

// ── Value handling ───────────────────────────────────────────────────────

/**
 * How a typed value is recorded.
 *
 * A value matching a declared input becomes a `param`, which is what makes the
 * capability reusable. A value matching a *secret* input becomes a `secret`
 * reference resolved from the vault at replay time — so the credential the model
 * typed is never written into an artifact we commit, and never has to be.
 * Anything else is a literal, because it is genuinely part of the flow.
 */
const literalOrParam = (
  value: string,
  parameters: readonly DiscoveryParameter[]
): ValueRef => {
  const exact = parameters.find((parameter) => parameter.value === value)
  if (exact) {
    return exact.sensitivity === "secret"
      ? { _tag: "secret", ref: exact.name }
      : { _tag: "param", name: exact.name }
  }

  /**
   * Not the whole value, but possibly part of it — a URL like
   * `/desk/member/12345` is mostly constant and partly the member id. Recording
   * that as a literal pins the capability to one member forever, so any embedded
   * parameter is lifted into a template.
   */
  const embedded = parameters.filter(
    (parameter) =>
      parameter.value.length >= 3 && value.includes(parameter.value)
  )

  if (embedded.length === 0) return { _tag: "literal", value }

  let text = value
  for (const parameter of [...embedded].sort(
    (a, b) => b.value.length - a.value.length
  )) {
    text = text.split(parameter.value).join(`{{${parameter.name}}}`)
  }

  return { _tag: "template", text }
}

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
