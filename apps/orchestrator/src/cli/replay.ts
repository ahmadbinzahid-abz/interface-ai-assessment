import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  applyOverlay,
  CapabilityArtifact,
  decodeCapability,
  encodeCapability,
  type ReplayResult,
} from "@workspace/contracts"
import {
  accumulateHealth,
  driftingSteps,
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
import { readOverlay } from "../server/repositories.js"

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
  /**
   * Which institution's variant of the product to run against.
   *
   * Resolves the base capability through that tenant's overlay before executing.
   * The point of the whole overlay mechanism is that this is the *only* thing
   * that differs — one recording, one artifact, N thin files.
   */
  readonly tenant?: string
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

  const base = await Effect.runPromise(decodeCapability(JSON.parse(raw)))

  const [name, version] = options.capability.split("@")
  const overlay = options.tenant
    ? await Effect.runPromise(
        readOverlay(name ?? "", version ?? "", options.tenant)
      )
    : undefined

  if (options.tenant && !overlay) {
    // Silence here would run the base artifact against the wrong institution and
    // report a puzzling target failure. Saying so is cheaper than debugging it.
    console.error(
      `No overlay for tenant "${options.tenant}". Expected ` +
        `capabilities/overlays/${options.capability}.${options.tenant}.json`
    )
    return EXIT.failed
  }

  const artifact = overlay ? applyOverlay(base, overlay) : base

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
  if (artifact.target.tenant) {
    console.log(
      `tenant      ${artifact.target.tenant} via overlay · ${artifact.target.entryPoint}`
    )
  }
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

    if (options.updateHealth) {
      await writeHealth(path, base, result, artifact.target.tenant ?? null)
    }

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
 * Written back onto the **base** capability, never the tenant-resolved one. The
 * resolved artifact carries the overlay's tenant and entry point, so writing it
 * back would quietly turn the shared base capability into Riverbend's — a
 * one-line bug that would surface weeks later looking like a bad merge.
 *
 * Off by default, because a read-only replay should not rewrite a committed file
 * unless somebody asked it to.
 */
const writeHealth = async (
  path: string,
  base: CapabilityArtifact,
  result: ReplayResult,
  tenant: string | null
): Promise<void> => {
  const updated = new CapabilityArtifact({
    ...base,
    health: accumulateHealth({ previous: base.health, result, tenant }),
  })

  const encoded = await Effect.runPromise(encodeCapability(updated))
  await writeFile(path, `${JSON.stringify(encoded, null, 2)}
`, "utf8")

  const drifting = tenant ? driftingSteps(updated.health, tenant) : []

  if (drifting.length > 0) {
    // The actionable form of a drift alarm: not "something has changed" but
    // "these steps need an entry in this tenant's overlay".
    console.log("")
    console.log(
      `drift       ${drifting.join(", ")} resolve by fallback on at least half of ${tenant}’s runs.`
    )
    console.log(`            Add them to capabilities/overlays/…${tenant}.json.`)
  }
}
