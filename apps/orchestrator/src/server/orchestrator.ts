import type {
  CapabilityArtifact,
  Intervention,
  SessionView,
} from "@workspace/contracts"
import {
  envVault,
  makeEvidenceWriter,
  runReplay,
  type Vault,
} from "@workspace/engine"
import { coreBankReadonly, makeRedactor, type Redactor } from "@workspace/policy"
import { Effect } from "effect"

import { EVIDENCE_DIR } from "../paths.js"
import { startLiveSession, type LiveSession } from "./live-session.js"

/**
 * The live half of the system: sessions in flight, and the runs inside them.
 *
 * Everything the console reads about the *past* comes from files
 * (`repositories.ts`). Everything it does to the *present* comes from here.
 * Keeping them apart matters because they have genuinely different lifetimes: an
 * evidence directory outlives the machine, and a session cannot outlive the
 * browser it is. An intervention that survived its browser would be an
 * invitation to take control of a page that no longer exists.
 */

export interface StartReplayOptions {
  readonly artifact: CapabilityArtifact
  readonly inputs: Record<string, string>
  readonly baseUrl: string
  /** Wait for a person when the run gets stuck, instead of ending it. */
  readonly live: boolean
  readonly headed?: boolean
}

export interface StartedReplay {
  readonly runId: string
  readonly evidenceRef: string
  readonly takeoverUrl: string | null
}

/**
 * Mask everything this run is entitled to hide, everywhere evidence is written.
 *
 * Shared by the CLI and the API rather than written twice: the list of things
 * that must never reach disk is exactly the kind of thing that grows, and a
 * second copy is a second place to forget.
 */
export const redactorFor = (
  artifact: CapabilityArtifact,
  inputs: Record<string, string>,
  vault: Vault
): Redactor =>
  makeRedactor({
    values: [
      ...artifact.steps.flatMap((step) => {
        const ref = "value" in step.action ? step.action.value : undefined
        const secret =
          ref?._tag === "secret" ? vault.resolve(ref.ref) : undefined
        return secret ? [secret] : []
      }),
      ...artifact.inputs
        .filter((input) => input.sensitivity !== "none")
        .map((input) => inputs[input.name])
        .filter((value): value is string => Boolean(value)),
    ],
  })

export const allowlistFor = (baseUrl: string) =>
  ({
    ...coreBankReadonly,
    allowedOrigins: [
      ...new Set([...coreBankReadonly.allowedOrigins, new URL(baseUrl).origin]),
    ],
  }) as typeof coreBankReadonly

export class Orchestrator {
  readonly #sessions = new Map<string, LiveSession>()
  /** Which session owns which open intervention, so the inbox can act on it. */
  readonly #byIntervention = new Map<string, LiveSession>()

  sessions(): readonly SessionView[] {
    return [...this.#sessions.values()].map((live) => this.#view(live))
  }

  #view(live: LiveSession): SessionView {
    return {
      sessionId: live.session.id,
      state: live.session.state(),
      takeoverUrl: live.takeoverUrl,
    } as SessionView
  }

  interventions(): readonly Intervention[] {
    return [...this.#sessions.values()].flatMap((live) =>
      live.registry.list()
    )
  }

  intervention(id: string): Intervention | undefined {
    return this.#byIntervention.get(id)?.registry.get(id)
  }

  sessionViewFor(interventionId: string): SessionView | undefined {
    const live = this.#byIntervention.get(interventionId)
    return live ? this.#view(live) : undefined
  }

  /**
   * An operator takes a session from the inbox rather than from the screencast.
   *
   * The same registry call the takeover socket makes, so there is one place that
   * decides whether a claim is allowed and one state machine that answers.
   */
  claim(
    interventionId: string,
    operatorId: string
  ): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    const live = this.#byIntervention.get(interventionId)
    if (!live) return { ok: false, reason: "No such open intervention." }

    return live.registry.claim(interventionId, operatorId)
  }

  resolve(
    interventionId: string,
    disposition: "retryStep" | "skipStep" | "abort",
    note?: string
  ): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    const live = this.#byIntervention.get(interventionId)
    if (!live) return { ok: false, reason: "No such open intervention." }

    return live.registry.resolve(
      interventionId,
      disposition === "abort"
        ? { _tag: "abort", note }
        : { _tag: "resume", disposition, note }
    )
  }

  /**
   * Start a replay and answer immediately.
   *
   * The run is deliberately *not* awaited. A replay takes seconds and, when it
   * escalates, may wait on a person for minutes — holding an HTTP request open
   * for that is the wrong shape, and it would make the console's "what is
   * happening right now" screen depend on a socket staying up. The caller gets a
   * run id, and the evidence directory is the thing that fills in.
   */
  async start(options: StartReplayOptions): Promise<StartedReplay> {
    const { artifact, inputs, baseUrl } = options

    const vault = envVault()
    const redactor = redactorFor(artifact, inputs, vault)
    const allowlist = allowlistFor(baseUrl)

    const runId = `replay-${new Date().toISOString().replace(/[:.]/g, "-")}`
    const evidence = await makeEvidenceWriter({
      root: EVIDENCE_DIR,
      runId,
      redactor,
    })

    const live = await startLiveSession({
      allowlist,
      redactor,
      headed: options.headed ?? false,
      onEvent: (event) => void evidence.event(event),
      onRaised: (intervention) => {
        this.#byIntervention.set(intervention.id, live)
      },
    })

    this.#sessions.set(live.session.id, live)

    void Effect.runPromise(
      runReplay(
        {
          surface: live.surface,
          evidence,
          allowlist,
          lease: live.lease,
          vault,
          /**
           * The one line that decides whether this run can be rescued.
           *
           * With an escalator the run pauses and waits for a person; without
           * one it ends with `Escalated` and the session closes. The console
           * offers both because a scheduled caller and a watching operator want
           * genuinely different behaviour from the same capability.
           */
          escalator: options.live ? live.registry : undefined,
          session: live.session,
        },
        // The same id the evidence directory is named after, so every
        // screenshot reference in an intervention resolves.
        { artifact, inputs, baseUrl, runId }
      )
    )
      .then((result) => evidence.json("result", result))
      .catch((cause: unknown) =>
        evidence.event({ kind: "RunCrashed", detail: String(cause) })
      )
      .finally(async () => {
        for (const intervention of live.registry.list()) {
          this.#byIntervention.delete(intervention.id)
        }
        this.#sessions.delete(live.session.id)
        await live.close()
      })

    return {
      runId,
      evidenceRef: evidence.runDir,
      takeoverUrl: options.live ? live.takeoverUrl : null,
    }
  }

  /** Shut every live browser down. Called when the server stops. */
  async close(): Promise<void> {
    const sessions = [...this.#sessions.values()]
    this.#sessions.clear()
    this.#byIntervention.clear()
    await Promise.all(sessions.map((live) => live.close()))
  }
}
