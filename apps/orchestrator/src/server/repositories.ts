import { readdir, readFile, stat } from "node:fs/promises"
import { basename, join } from "node:path"

import {
  applyOverlay,
  CapabilitySummary,
  decodeCapability,
  decodeOverlay,
  RunDetail,
  RunSummary,
  type CapabilityArtifact,
  type ReplayResult,
  type TenantOverlay,
  type TraceEvent,
} from "@workspace/contracts"
import { Effect } from "effect"

import { CAPABILITIES_DIR, EVIDENCE_DIR, OVERLAYS_DIR } from "../paths.js"

/**
 * Where the console's read model comes from.
 *
 * Two different stores, on purpose, and the split is the same one the design
 * makes everywhere else:
 *
 *  - **Capabilities are files in the repository.** They are code-like assets:
 *    reviewed in a pull request, versioned with the system, diffable when a
 *    recording changes. A database row nobody reviews is the wrong home for the
 *    thing whose whole value is that a human read it.
 *  - **Runs are evidence directories.** They are already written to disk by the
 *    evidence writer during the run, redacted on the way in. Reading them back
 *    rather than duplicating them into Postgres means the console shows exactly
 *    what an auditor would find, and there is no second copy to disagree.
 *
 * This is a seam, not a final answer: Postgres belongs here the moment runs need
 * to be queried across machines rather than listed from one. Everything above
 * talks to these functions, so that change does not reach the handlers.
 */

// ── Capabilities ─────────────────────────────────────────────────────────

/** `lookupMemberSavingsBalance@1.0.0.json` → its two halves. */
const parseCapabilityFile = (
  file: string
): { readonly name: string; readonly version: string } | undefined => {
  const stem = basename(file, ".json")
  const at = stem.lastIndexOf("@")
  if (at <= 0) return undefined

  return { name: stem.slice(0, at), version: stem.slice(at + 1) }
}

export const capabilityFileName = (name: string, version: string): string =>
  `${name}@${version}.json`

export const readCapability = (
  name: string,
  version: string
): Effect.Effect<CapabilityArtifact | undefined> =>
  Effect.gen(function* () {
    const path = join(CAPABILITIES_DIR, capabilityFileName(name, version))

    const raw = yield* Effect.tryPromise(() => readFile(path, "utf8")).pipe(
      Effect.catchAll(() => Effect.succeed(undefined))
    )
    if (raw === undefined) return undefined

    // A capability file that does not decode is a broken commit, not a missing
    // capability. Returning undefined would hide it; failing the request says so.
    return yield* decodeCapability(JSON.parse(raw)).pipe(
      Effect.catchAll(() => Effect.succeed(undefined))
    )
  })

/**
 * The catalog list.
 *
 * `worstFallbackRate` is flattened here rather than in the UI: the list answers
 * "is anything rotting?", and a per-step map is not an answer to that question.
 */
export const summarizeCapability = (
  artifact: CapabilityArtifact,
  overlayTenants: readonly string[] = []
): CapabilitySummary =>
  new CapabilitySummary({
    id: artifact.id,
    name: artifact.name,
    version: artifact.version,
    status: artifact.status,
    description: artifact.description,
    vendorProduct: artifact.target.vendorProduct,
    tenant: artifact.target.tenant ?? null,
    overlayTenants,
    stepCount: artifact.steps.length,
    inputNames: artifact.inputs.map((input) => input.name),
    outputNames: artifact.outputs.map((output) => output.name),
    outcomeTags: artifact.outcomes.map((outcome) => outcome.tag),
    replays: artifact.health?.replays ?? 0,
    successes: artifact.health?.successes ?? 0,
    worstFallbackRate: Math.max(
      0,
      ...Object.values(artifact.health?.fallbackHitRate ?? {})
    ),
    lastVerifiedAt: artifact.health?.lastVerifiedAt ?? null,
  })

export const listCapabilities = (): Effect.Effect<
  readonly CapabilitySummary[]
> =>
  Effect.gen(function* () {
    const files = yield* Effect.tryPromise(() =>
      readdir(CAPABILITIES_DIR)
    ).pipe(Effect.catchAll(() => Effect.succeed([] as string[])))

    const summaries: CapabilitySummary[] = []

    for (const file of files) {
      if (!file.endsWith(".json")) continue

      const parsed = parseCapabilityFile(file)
      if (!parsed) continue

      const artifact = yield* readCapability(parsed.name, parsed.version)
      if (!artifact) continue

      const tenants = yield* listOverlayTenants(parsed.name, parsed.version)
      summaries.push(summarizeCapability(artifact, tenants))
    }

    return summaries.sort((a, b) => a.name.localeCompare(b.name))
  })

// ── Tenant overlays ──────────────────────────────────────────────────────

/**
 * Resolve a capability for one tenant.
 *
 * One base artifact plus N thin overlays, never N recordings. The merge is
 * deterministic and the resolved artifact records which tenant it came from, so
 * a run can always be traced back to exactly what executed.
 *
 * A tenant with no overlay is not an error: most institutions running a vendor
 * product are configured identically enough that the base capability just works,
 * and demanding an empty file per tenant would be ceremony.
 */
export const readOverlay = (
  name: string,
  version: string,
  tenant: string
): Effect.Effect<TenantOverlay | undefined> =>
  Effect.gen(function* () {
    const path = join(OVERLAYS_DIR, `${name}@${version}.${tenant}.json`)

    const raw = yield* Effect.tryPromise(() => readFile(path, "utf8")).pipe(
      Effect.catchAll(() => Effect.succeed(undefined))
    )
    if (raw === undefined) return undefined

    return yield* decodeOverlay(JSON.parse(raw)).pipe(
      Effect.catchAll(() => Effect.succeed(undefined))
    )
  })

/** The base artifact, specialised for a tenant when one is asked for. */
export const readCapabilityForTenant = (
  name: string,
  version: string,
  tenant?: string
): Effect.Effect<CapabilityArtifact | undefined> =>
  Effect.gen(function* () {
    const base = yield* readCapability(name, version)
    if (!base || !tenant) return base

    const overlay = yield* readOverlay(name, version, tenant)
    return overlay ? applyOverlay(base, overlay) : base
  })

/** Which tenants this capability has an overlay for. */
export const listOverlayTenants = (
  name: string,
  version: string
): Effect.Effect<readonly string[]> =>
  Effect.gen(function* () {
    const files = yield* Effect.tryPromise(() => readdir(OVERLAYS_DIR)).pipe(
      Effect.catchAll(() => Effect.succeed([] as string[]))
    )

    const prefix = `${name}@${version}.`

    return files
      .filter((file) => file.startsWith(prefix) && file.endsWith(".json"))
      .map((file) => file.slice(prefix.length, -".json".length))
      .sort()
  })

// ── Runs ─────────────────────────────────────────────────────────────────

const classifyArtifact = (
  name: string
): "screenshot" | "json" | "log" | "other" =>
  name.endsWith(".png")
    ? "screenshot"
    : name.endsWith(".json")
      ? "json"
      : name.endsWith(".jsonl") || name.endsWith(".log")
        ? "log"
        : "other"

/**
 * A run directory, read back.
 *
 * `result.json` is the contract the caller was given; `trace.jsonl` is the
 * evidence behind it. A run that is still going has the second and not the
 * first, which is exactly how "Running" is detected — no status field to keep
 * in sync, and no way for the two to disagree.
 */
const readRunDirectory = (
  runId: string
): Effect.Effect<
  | {
      readonly summary: RunSummary
      readonly result: ReplayResult | null
      readonly trace: readonly TraceEvent[]
      readonly artifacts: readonly {
        name: string
        kind: "screenshot" | "json" | "log" | "other"
        bytes: number
      }[]
    }
  | undefined
> =>
  Effect.gen(function* () {
    const dir = join(EVIDENCE_DIR, runId)

    const entries = yield* Effect.tryPromise(() => readdir(dir)).pipe(
      Effect.catchAll(() => Effect.succeed(undefined))
    )
    if (!entries) return undefined

    const rawResult = yield* Effect.tryPromise(() =>
      readFile(join(dir, "result.json"), "utf8")
    ).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

    const result = rawResult
      ? (JSON.parse(rawResult) as ReplayResult)
      : null

    const rawTrace = yield* Effect.tryPromise(() =>
      readFile(join(dir, "trace.jsonl"), "utf8")
    ).pipe(Effect.catchAll(() => Effect.succeed("")))

    /**
     * A discovery run is identified by the model that did it.
     *
     * It has no capability name yet — the name is chosen at compile time, after
     * the run — so labelling the row with the model is both true and the thing
     * an operator comparing recordings actually wants to see.
     */
    const rawRun = yield* Effect.tryPromise(() =>
      readFile(join(dir, "run.json"), "utf8")
    ).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

    const modelId =
      (rawRun
        ? ((JSON.parse(rawRun) as { modelId?: unknown }).modelId ?? undefined)
        : undefined) ??
      // A run that was interrupted never wrote `run.json`, but its opening
      // trace line always names the model. Falling back keeps an abandoned
      // recording identifiable rather than anonymous.
      headerLine(rawTrace)?.["model"]

    /**
     * The trace file holds every evidence event; only some of them are typed
     * `TraceEvent`s. The rest — `ReplayStarted`, `InterventionRaised`,
     * `OperatorAction` — are keyed by `kind` and are shown as the raw log. The
     * discriminant tells them apart with no schema guessing.
     */
    const trace = rawTrace
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event): event is TraceEvent => "_tag" in event)

    const artifacts = yield* Effect.tryPromise(() =>
      Promise.all(
        entries.map(async (name) => ({
          name,
          kind: classifyArtifact(name),
          bytes: await stat(join(dir, name))
            .then((info) => info.size)
            .catch(() => 0),
        }))
      )
    ).pipe(Effect.catchAll(() => Effect.succeed([])))

    const opening = headerLine(rawTrace)
    const kind = opening?.["kind"] === "RunStarted" ? "discovery" : "replay"

    /**
     * The capability's *name*, not its id.
     *
     * `capabilityId` is `cap_lookupmembersavingsbalance`, which is correct and
     * unreadable. The opening trace line carries `lookupMemberSavingsBalance@1.0.0`,
     * which is what a person scanning a list is looking for.
     */
    const named = capabilityFromTrace(rawTrace)
    const [name, version] = named.split("@")

    return {
      summary: new RunSummary({
        runId,
        kind,
        capability:
          kind === "discovery"
            ? typeof modelId === "string"
              ? modelId
              : "discovery"
            : name && name !== "unknown"
              ? name
              : (result?.summary.capabilityId ?? "unknown"),
        capabilityVersion:
          kind === "discovery"
            ? ""
            : (version ?? result?.summary.capabilityVersion ?? ""),
        startedAt: result?.summary.startedAt ?? startedAtFromTrace(rawTrace),
        // A discovery run produced an artifact rather than an answer, so it has
        // no branch of the replay result union to report.
        outcome:
          kind === "discovery" ? "Recorded" : (result?._tag ?? "Running"),
        detail:
          kind === "discovery"
            ? goalFromTrace(rawTrace)
            : describeOutcome(result),
        durationMs: result?.summary.durationMs ?? null,
        evidenceRef: dir,
      }),
      result,
      trace,
      artifacts,
    }
  })

/** The one line of a result a list should show. */
const describeOutcome = (result: ReplayResult | null): string | null => {
  if (!result) return null

  switch (result._tag) {
    case "Succeeded":
      return Object.keys(result.outputs).join(", ") || null
    case "BusinessOutcome":
      return result.outcome
    case "Escalated":
      return result.reason
    case "Failed":
      return result.error._tag
  }
}

/**
 * The run's header line, found rather than assumed.
 *
 * It used to be the first line, and then live runs began writing a control
 * transition before it — so every live run showed up in the console with no
 * capability name. Searching for the header by its `kind` is both correct and
 * immune to whatever gets logged first next.
 */
const HEADER_KINDS = new Set(["ReplayStarted", "RunStarted"])

const headerLine = (raw: string): Record<string, unknown> | undefined => {
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue

    try {
      const event = JSON.parse(line) as Record<string, unknown>
      if (typeof event["kind"] === "string" && HEADER_KINDS.has(event["kind"]))
        return event
    } catch {
      // A truncated last line in a run still being written. Keep looking.
    }
  }

  return undefined
}

const firstTraceLine = (raw: string): Record<string, unknown> | undefined => {
  const line = raw.split("\n").find((candidate) => candidate.trim().length > 0)
  if (!line) return undefined
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return undefined
  }
}

const startedAtFromTrace = (raw: string): string => {
  const at = firstTraceLine(raw)?.["at"]
  return typeof at === "string" ? at : new Date(0).toISOString()
}

const capabilityFromTrace = (raw: string): string => {
  const capability = headerLine(raw)?.["capability"]
  return typeof capability === "string" ? capability : "unknown"
}

/** A discovery run's one-line identity is what it was asked to accomplish. */
const goalFromTrace = (raw: string): string | null => {
  const goal = headerLine(raw)?.["goal"]
  return typeof goal === "string" ? goal : null
}

export const findRun = (
  runId: string
): Effect.Effect<RunDetail | undefined> =>
  Effect.gen(function* () {
    const found = yield* readRunDirectory(runId)
    if (!found) return undefined

    return new RunDetail({
      summary: found.summary,
      result: found.result,
      trace: found.trace,
      artifacts: found.artifacts,
    })
  })

export const listRuns = (): Effect.Effect<readonly RunSummary[]> =>
  Effect.gen(function* () {
    const entries = yield* Effect.tryPromise(() =>
      readdir(EVIDENCE_DIR, { withFileTypes: true })
    ).pipe(Effect.catchAll(() => Effect.succeed([])))

    const summaries: RunSummary[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const found = yield* readRunDirectory(entry.name)
      if (found) summaries.push(found.summary)
    }

    // Newest first: an operator opening the console cares about what just
    // happened, not about the first run ever recorded.
    return summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  })
