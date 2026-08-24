import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { dirname, isAbsolute, join, resolve } from "node:path"

import { encodeCapability } from "@workspace/contracts"
import {
  compileCapability,
  decodeDiscoveryRun,
  type DiscoveryParameter,
} from "@workspace/engine"
import { coreBankReadonly } from "@workspace/policy"
import { Effect } from "effect"

import { CAPABILITIES_DIR, REPO_ROOT } from "../paths.js"

/**
 * `cua recompile` — re-emit an artifact from a saved run.
 *
 * The compiler improves over time: it learns that a credential must never reach
 * a checkpoint, that a success condition must not echo the answer, that a typed
 * field's check is knowable without asking a model. Every one of those
 * improvements should apply to capabilities that already exist, and re-running
 * the model to get them would be both expensive and non-deterministic — a second
 * run explores differently and produces a different recording.
 *
 * So discovery saves the raw recording, and this replays it through the current
 * compiler. Same steps, better artifact, no model.
 *
 * The parameter *values* are supplied again rather than stored: they are the
 * member id and the credentials, and the whole point of the recording is that it
 * does not contain them.
 */

export interface RecompileOptions {
  readonly runFile: string
  readonly name: string
  readonly version: string
  readonly vendorProduct: string
  readonly entryPoint: string
  readonly parameters: readonly DiscoveryParameter[]
}

/**
 * The digest of the run's own trace, computed the same way `discover` does it —
 * so a recompiled artifact carries the identical provenance digest.
 */
const digestOfTrace = async (runFile: string): Promise<string> => {
  const trace = await readFile(
    join(dirname(runFile), "trace.jsonl"),
    "utf8"
  ).catch(() => "")

  return `sha256:${createHash("sha256").update(trace).digest("hex")}`
}

/** When the recording was made, taken from its own first trace line. */
const discoveredAtOf = async (runFile: string): Promise<string | undefined> => {
  const trace = await readFile(
    join(dirname(runFile), "trace.jsonl"),
    "utf8"
  ).catch(() => "")

  const first = trace.split("\n").find((line) => line.trim().length > 0)
  if (!first) return undefined

  try {
    const at = (JSON.parse(first) as { at?: unknown }).at
    return typeof at === "string" ? at : undefined
  } catch {
    return undefined
  }
}

export const recompile = async (options: RecompileOptions): Promise<number> => {
  /**
   * `--run evidence/…` means what a person typing it at the repository root
   * means, not what it means relative to this package's directory. Resolving
   * against the repo root is the difference between a working command and a
   * "no saved run" that looks like the evidence is missing.
   */
  const runFile = isAbsolute(options.runFile)
    ? options.runFile
    : resolve(REPO_ROOT, options.runFile)

  const raw = await readFile(runFile, "utf8").catch(() => {
    throw new Error(`No saved run at ${runFile}.`)
  })

  // Decoded, not cast: the recording contains target descriptors, which are
  // classes with their own validation. A cast would produce plain objects that
  // look right and fail the moment the compiler builds a step from them.
  const run = await Effect.runPromise(decodeDiscoveryRun(JSON.parse(raw)))

  if (run.result._tag !== "Completed") {
    console.error(
      `That run ${run.result._tag}; only a completed run can be compiled.`
    )
    return 1
  }

  const origin = new URL(options.entryPoint).origin

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
    /**
     * The *original* transcript digest, not a note saying this was recompiled.
     *
     * Provenance answers "which model run produced this flow", and recompiling
     * does not change the answer — the same recording is being read through a
     * newer compiler. Stamping `recompiled-from-…` here would lose the one thing
     * that lets an artifact be tied back to the trace it came from.
     */
    transcriptDigest: await digestOfTrace(runFile),
    discoveredAt: await discoveredAtOf(runFile),
  })

  const encoded = await Effect.runPromise(encodeCapability(artifact))

  await mkdir(CAPABILITIES_DIR, { recursive: true })
  const path = join(CAPABILITIES_DIR, `${options.name}@${options.version}.json`)
  await writeFile(path, `${JSON.stringify(encoded, null, 2)}\n`, "utf8")

  console.log(`recompiled  ${path}`)
  console.log(`from run    ${run.runId} (${run.modelId})`)
  console.log(
    `steps       ${artifact.steps.length} of ${run.steps.length} recorded`
  )
  console.log(
    `outcomes    ${artifact.outcomes.map((o) => o.tag).join(", ") || "(none)"}`
  )

  return 0
}
