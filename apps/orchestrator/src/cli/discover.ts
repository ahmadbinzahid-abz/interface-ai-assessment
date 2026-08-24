import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { encodeCapability } from "@workspace/contracts"
import {
  compileCapability,
  makeEvidenceWriter,
  makeGeminiClient,
  runDiscovery,
  type DiscoveryParameter,
} from "@workspace/engine"
import { coreBankReadonly, makeRedactor } from "@workspace/policy"
import { ControlLease, makeWebSurface } from "@workspace/surface"
import { Effect } from "effect"
import { chromium } from "playwright"

import { CAPABILITIES_DIR, EVIDENCE_DIR } from "../paths.js"

/**
 * `cua discover` — the LLM-driven run that turns a goal into a capability.
 *
 * This is the expensive path, and it runs once per capability. Everything after
 * it (`cua replay`) is deterministic and never calls a model.
 */

export interface DiscoverOptions {
  readonly goal: string
  readonly entryPoint: string
  readonly name: string
  readonly parameters: readonly DiscoveryParameter[]
  readonly vendorProduct: string
  readonly version: string
  readonly headed: boolean
  readonly maxTurns: number
}

export const discover = async (options: DiscoverOptions): Promise<number> => {
  const origin = new URL(options.entryPoint).origin

  const allowlist = {
    ...coreBankReadonly,
    // The stand-in may run on any port locally; the rest of the policy stands.
    allowedOrigins: [...new Set([...coreBankReadonly.allowedOrigins, origin])],
  } as typeof coreBankReadonly

  /**
   * Every declared parameter value is masked in evidence, along with the
   * credentials used to sign on — and each mask is labelled with the field it
   * came from.
   *
   * The label is what makes the recording recompilable later. A run whose member
   * number was masked to a bare `[redacted:declared]` cannot be turned back into
   * a capability, because the compiler parameterises by searching for the value
   * it can no longer see.
   */
  const redactor = makeRedactor({
    values: options.parameters
      .filter((parameter) => parameter.sensitivity !== "none")
      .map((parameter) => ({
        value: parameter.value,
        label: parameter.name,
      })),
  })

  const model = makeGeminiClient()

  const browser = await chromium.launch({ headless: !options.headed })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

  const lease = new ControlLease()
  const surface = await Effect.runPromise(makeWebSurface({ page, lease }))

  const runId = `discovery-${new Date().toISOString().replace(/[:.]/g, "-")}`
  const evidence = await makeEvidenceWriter({
    root: EVIDENCE_DIR,
    runId,
    redactor,
  })

  console.log(`goal      ${options.goal}`)
  console.log(`entry     ${options.entryPoint}`)
  console.log(`model     ${model.id}`)
  console.log(`evidence  ${evidence.runDir}`)
  console.log("")

  try {
    const run = await Effect.runPromise(
      runDiscovery(
        { surface, model, evidence, allowlist, lease },
        {
          goal: options.goal,
          entryPoint: options.entryPoint,
          parameters: options.parameters,
          maxTurns: options.maxTurns,
        }
      )
    )

    for (const step of run.steps) {
      console.log(
        `  ${step.id.padEnd(4)} ${step.action._tag.padEnd(9)} ${step.intent}`
      )
    }
    console.log("")
    console.log(
      `result    ${run.result._tag} after ${run.turns} turns (${run.durationMs}ms)`
    )

    if (run.result._tag !== "Completed") {
      const detail = "reason" in run.result ? run.result.reason : ""
      console.log(`          ${detail}`)
      await evidence.json("run", run)
      // Not a crash: escalation and giving up are legitimate endings that a
      // human now has to act on, so the run is exit code 2 rather than 1.
      return run.result._tag === "Escalated" ? 2 : 1
    }

    // The transcript itself is never persisted — it contains whatever the model
    // saw on screen, which here is customer data. The digest ties an artifact to
    // the run that produced it without keeping the run's contents.
    const trace = await readFile(
      join(evidence.runDir, "trace.jsonl"),
      "utf8"
    ).catch(() => "")
    const transcriptDigest = `sha256:${createHash("sha256").update(trace).digest("hex")}`

    const artifact = compileCapability({
      run,
      capabilityId: `cap_${options.name.replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase()}`,
      name: options.name,
      version: options.version,
      vendorProduct: options.vendorProduct,
      surfaceKind: "legacy-web",
      entryPoint: options.entryPoint.replace(origin, "{{baseUrl}}"),
      installOrigin: origin,
      parameters: options.parameters,
      allowlistRef: coreBankReadonly.id,
      transcriptDigest,
    })

    const encoded = await Effect.runPromise(encodeCapability(artifact))
    const json = `${JSON.stringify(encoded, null, 2)}\n`

    await mkdir(CAPABILITIES_DIR, { recursive: true })
    const capabilityPath = join(
      CAPABILITIES_DIR,
      `${options.name}@${options.version}.json`
    )
    await writeFile(capabilityPath, json, "utf8")

    // A copy travels with the run that produced it, so evidence is self-contained.
    await writeFile(join(evidence.runDir, "capability.json"), json, "utf8")

    // The raw recording, kept so an artifact can be re-compiled after a change to
    // the compiler without paying for another model run. Redacted like everything
    // else that reaches the evidence directory.
    await evidence.json("run", run)

    console.log("")
    console.log(`capability  ${capabilityPath}`)
    console.log(
      `status      ${artifact.status} — review it before approving unattended replay`
    )
    console.log(
      `inputs      ${artifact.inputs.map((input) => input.name).join(", ") || "(none)"}`
    )
    console.log(
      `outputs     ${artifact.outputs.map((output) => output.name).join(", ") || "(none)"}`
    )
    console.log(
      `outcomes    ${artifact.outcomes.map((outcome) => outcome.tag).join(", ") || "(none)"}`
    )

    return 0
  } finally {
    await Effect.runPromise(surface.close())
    await browser.close()
  }
}
