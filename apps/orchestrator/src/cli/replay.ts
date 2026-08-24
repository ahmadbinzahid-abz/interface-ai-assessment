import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  CapabilityArtifact,
  decodeCapability,
  encodeCapability,
  Health,
  type ReplayResult,
} from "@workspace/contracts"
import {
  envVault,
  makeEvidenceWriter,
  runReplay,
  type Escalator,
  type Session,
} from "@workspace/engine"
import { coreBankReadonly, makeRedactor } from "@workspace/policy"
import { ControlLease, makeWebSurface, type Surface } from "@workspace/surface"
import { Effect } from "effect"
import { chromium } from "playwright"

import { CAPABILITIES_DIR, EVIDENCE_DIR } from "../paths.js"
import { startLiveSession } from "../server/live-session.js"

/**
 * `cua replay` — the production execution path.
 *
 * No model, no API key, no network beyond the application itself. This is what an
 * AI agent triggers when it needs the capability done, and what a scheduled job
 * runs a thousand times a day.
 */

export interface ReplayOptions {
  readonly capability: string
  readonly inputs: Record<string, string>
  readonly baseUrl: string
  readonly headed: boolean
  /** Write replay telemetry back into the artifact. Off by default. */
  readonly updateHealth: boolean
  /**
   * Open a takeover gateway and *wait for a person* when the run gets stuck,
   * instead of ending the run with `Escalated`.
   *
   * Off by default on purpose: a scheduled replay has nobody to ask, and a batch
   * job that silently blocks forever waiting for an operator is worse than one
   * that reports it needed one.
   */
  readonly live: boolean
  readonly waitMs?: number
}

/** Exit codes distinguish the branches of the result union for a shell caller. */
const EXIT = {
  succeeded: 0,
  failed: 1,
  escalated: 2,
  businessOutcome: 3,
} as const

const describe = (result: ReplayResult): number => {
  switch (result._tag) {
    case "Succeeded":
      console.log(`result      Succeeded in ${result.summary.durationMs}ms`)
      console.log("outputs")
      for (const [name, value] of Object.entries(result.outputs)) {
        console.log(`  ${name} = ${String(value)}`)
      }
      return EXIT.succeeded

    case "BusinessOutcome":
      // Not a failure. The application answered, and this is the answer.
      console.log(
        `result      ${result.outcome} (a business outcome, not an error)`
      )
      console.log(`            ${result.detail}`)
      console.log(`at step     ${result.atStepId}`)
      return EXIT.businessOutcome

    case "Escalated":
      console.log(`result      Escalated — a human is needed`)
      console.log(`intervention ${result.interventionId}`)
      console.log(`at step     ${result.atStepId}`)
      console.log(`reason      ${result.reason}`)
      return EXIT.escalated

    case "Failed": {
      console.log(`result      Failed — ${result.error._tag}`)
      const error = result.error

      if ("stepId" in error && error.stepId)
        console.log(`at step     ${error.stepId}`)
      if ("expected" in error) console.log(`expected    ${error.expected}`)
      if ("observed" in error) console.log(`observed    ${error.observed}`)
      if ("issues" in error)
        for (const issue of error.issues) console.log(`            ${issue}`)
      if ("detail" in error && error.detail)
        console.log(`detail      ${error.detail}`)
      if ("targetDescription" in error)
        console.log(`target      ${error.targetDescription}`)
      if ("reason" in error) console.log(`reason      ${error.reason}`)

      return EXIT.failed
    }
  }
}

export const replay = async (options: ReplayOptions): Promise<number> => {
  const path = join(CAPABILITIES_DIR, `${options.capability}.json`)

  const raw = await readFile(path, "utf8").catch(() => {
    throw new Error(`No capability at ${path}. Run \`cua discover\` first.`)
  })

  const artifact = await Effect.runPromise(decodeCapability(JSON.parse(raw)))

  const origin = new URL(options.baseUrl).origin
  const allowlist = {
    ...coreBankReadonly,
    allowedOrigins: [...new Set([...coreBankReadonly.allowedOrigins, origin])],
  } as typeof coreBankReadonly

  const vault = envVault()

  // Mask the credentials this capability will resolve, and any input it declared
  // sensitive, everywhere evidence is written.
  const redactor = makeRedactor({
    values: [
      ...artifact.steps.flatMap((step) => {
        const ref = "value" in step.action ? step.action.value : undefined
        const secret =
          ref?._tag === "secret" ? vault.resolve(ref.ref) : undefined
        return secret ? [secret] : []
      }),
      ...artifact.inputs
        .filter((input) => input.sensitivity !== "none")
        .map((input) => options.inputs[input.name])
        .filter((value): value is string => Boolean(value)),
    ],
  })

  const runId = `replay-${new Date().toISOString().replace(/[:.]/g, "-")}`
  const evidence = await makeEvidenceWriter({
    root: EVIDENCE_DIR,
    runId,
    redactor,
  })

  /**
   * Two ways to hold a browser, and the difference is who can be asked.
   *
   * A plain replay owns a page and a lease and nothing else. A live one owns a
   * session, an intervention queue and a takeover socket — the same browser,
   * with somewhere for the run to escalate *to*.
   */
  const live = options.live
    ? await startLiveSession({
        allowlist,
        redactor,
        headed: options.headed,
        awaitTimeoutMs: options.waitMs,
        onEvent: (event) => void evidence.event(event),
        onRaised: (intervention) => {
          console.log("")
          console.log(`⏸  paused — ${intervention.reason}`)
          console.log(`   step        ${intervention.stepId} · ${intervention.stepIntent}`)
          console.log(`   intervention ${intervention.id}`)
          console.log(`   screenshot  ${intervention.screenshotRef ?? "(none)"}`)
          console.log(`   take control at ${liveTakeoverUrl}`)
          console.log("")
        },
      })
    : undefined

  const liveTakeoverUrl = live?.takeoverUrl ?? ""

  const bare = live
    ? undefined
    : await (async () => {
        const browser = await chromium.launch({ headless: !options.headed })
        const page = await browser.newPage({
          viewport: { width: 1280, height: 900 },
        })
        const lease = new ControlLease()
        const surface = await Effect.runPromise(makeWebSurface({ page, lease }))
        return { browser, lease, surface }
      })()

  const surface: Surface = live?.surface ?? bare!.surface
  const lease: ControlLease = live?.lease ?? bare!.lease
  const escalator: Escalator | undefined = live?.registry
  const session: Session | undefined = live?.session

  console.log(
    `capability  ${artifact.name}@${artifact.version} (${artifact.status})`
  )
  console.log(
    `inputs      ${Object.keys(options.inputs).join(", ") || "(none)"}`
  )
  console.log(`evidence    ${evidence.runDir}`)
  if (live) console.log(`takeover    ${live.takeoverUrl}`)
  console.log("")

  try {
    const result = await Effect.runPromise(
      runReplay(
        { surface, evidence, allowlist, lease, vault, escalator, session },
        {
          artifact,
          inputs: options.inputs,
          baseUrl: options.baseUrl,
          runId,
        }
      )
    )

    for (const event of result.trace) {
      if (event._tag === "StepStarted")
        console.log(`  ${event.stepId.padEnd(4)} ${event.intent}`)
      if (event._tag === "RecoveryApplied") {
        console.log(`       ↻ recovered: ${event.recovery}`)
      }
      if (event._tag === "ControlHandedOver") {
        console.log(`       ⇄ handed to a person (${event.trigger})`)
      }
      if (event._tag === "ControlReturned") {
        console.log(
          `       ⇄ ${event.by} handed back after ${event.operatorActions} ` +
            `action(s) — ${event.disposition}`
        )
      }
      if (event._tag === "TargetResolved" && event.resolution.rank > 0) {
        // A step no longer resolving the way it was recorded. Still works, but
        // it is the earliest sign this tenant's UI has moved.
        console.log(
          `       ⚠ resolved at rank ${event.resolution.rank} (drift)`
        )
      }
    }
    console.log("")

    const code = describe(result)
    await evidence.json("result", result)

    if (options.updateHealth) await writeHealth(path, artifact, result)

    return code
  } finally {
    if (live) {
      await live.close()
    } else if (bare) {
      await Effect.runPromise(bare.surface.close())
      await bare.browser.close()
    }
  }
}

/**
 * Accumulate replay telemetry on the artifact.
 *
 * `fallbackHitRate` is the drift alarm: a step that used to resolve by role and
 * now resolves by its markup fallback still passes, but it is telling you this
 * install has changed. Off by default, because a read-only replay should not
 * rewrite a committed file unless someone asked it to.
 */
const writeHealth = async (
  path: string,
  artifact: CapabilityArtifact,
  result: ReplayResult
): Promise<void> => {
  const previous = artifact.health
  const replays = (previous?.replays ?? 0) + 1
  const successes =
    (previous?.successes ?? 0) + (result._tag === "Succeeded" ? 1 : 0)

  const fallbackHitRate: Record<string, number> = {
    ...(previous?.fallbackHitRate ?? {}),
  }

  for (const event of result.trace) {
    if (event._tag !== "TargetResolved") continue
    const previousRate = fallbackHitRate[event.stepId] ?? 0
    const hit = event.resolution.rank > 0 ? 1 : 0
    // Running mean across every replay of this step.
    fallbackHitRate[event.stepId] =
      (previousRate * (replays - 1) + hit) / replays
  }

  const updated = new CapabilityArtifact({
    ...artifact,
    health: new Health({
      replays,
      successes,
      lastVerifiedAt: new Date().toISOString(),
      fallbackHitRate,
    }),
  })

  const encoded = await Effect.runPromise(encodeCapability(updated))
  await writeFile(path, `${JSON.stringify(encoded, null, 2)}\n`, "utf8")
}
