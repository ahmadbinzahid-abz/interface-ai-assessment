import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "@effect/platform"
import { Schema } from "effect"

import { CapabilityArtifact } from "./capability.js"
import { ControlState, Intervention } from "./intervention.js"
import { ReplayResult, TraceEvent } from "./result.js"

/**
 * The API as a value.
 *
 * Not route registrations with a hand-written client beside them — one
 * declaration that the server implements, the browser console consumes, and the
 * tests exercise. They cannot drift, because there is nothing to keep in sync:
 * add an endpoint here and it appears on the client; add a declared error and
 * every screen that consumes it stops compiling until somebody decides what it
 * should look like.
 *
 * The types being carried across are the same ones the engine already speaks —
 * `CapabilityArtifact`, `ReplayResult`, `Intervention`. The console renders the
 * replay result union directly, which is what makes "a business outcome is not
 * an error" true in the UI and not just in the executor.
 */

// ── Errors ───────────────────────────────────────────────────────────────

export class CapabilityNotFound extends Schema.TaggedError<CapabilityNotFound>()(
  "CapabilityNotFound",
  { name: Schema.String, version: Schema.String }
) {}

export class RunNotFound extends Schema.TaggedError<RunNotFound>()(
  "RunNotFound",
  { runId: Schema.String }
) {}

export class InterventionNotFound extends Schema.TaggedError<InterventionNotFound>()(
  "InterventionNotFound",
  { interventionId: Schema.String }
) {}

/**
 * The operator asked for something the control state does not allow — claiming
 * an intervention somebody else is driving, handing back a session they do not
 * hold. Carries the state machine's own reason, so the console can say what is
 * actually true rather than "failed".
 */
export class ControlRefused extends Schema.TaggedError<ControlRefused>()(
  "ControlRefused",
  { reason: Schema.String }
) {}

/** A replay was asked for with inputs the capability's contract rejects. */
export class InvalidInputs extends Schema.TaggedError<InvalidInputs>()(
  "InvalidInputs",
  { issues: Schema.Array(Schema.String) }
) {}

// ── Read models ──────────────────────────────────────────────────────────

/**
 * A capability as the catalog lists it.
 *
 * Deliberately not the whole artifact: a list of twenty capabilities does not
 * need twenty step arrays. The detail endpoint returns the artifact itself,
 * because the point of the artifact is that a human reads it.
 */
export class CapabilitySummary extends Schema.Class<CapabilitySummary>(
  "CapabilitySummary"
)({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  status: Schema.Literal("draft", "candidate", "approved", "deprecated"),
  description: Schema.String,
  vendorProduct: Schema.String,
  tenant: Schema.NullOr(Schema.String),
  /** Institutions this capability has an overlay for. */
  overlayTenants: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),
  stepCount: Schema.Number,
  inputNames: Schema.Array(Schema.String),
  outputNames: Schema.Array(Schema.String),
  outcomeTags: Schema.Array(Schema.String),
  replays: Schema.Number,
  successes: Schema.Number,
  /**
   * The highest per-step fallback rate on this capability.
   *
   * One number because a list wants one number: it answers "is this capability
   * quietly rotting?" and the per-step detail is one click away.
   */
  worstFallbackRate: Schema.Number,
  lastVerifiedAt: Schema.NullOr(Schema.String),
}) {}

/** A run as the run list shows it. */
export class RunSummary extends Schema.Class<RunSummary>("RunSummary")({
  runId: Schema.String,
  /**
   * Discovery and replay both leave evidence, and both belong in the list.
   *
   * They are different *kinds* of run rather than different outcomes of one: a
   * discovery run has no declared result contract to report, because its output
   * is an artifact rather than an answer. Flattening them into one status field
   * would mean inventing a fake outcome for half the rows.
   */
  kind: Schema.Literal("replay", "discovery"),
  capability: Schema.String,
  capabilityVersion: Schema.String,
  startedAt: Schema.String,
  /** The result union's tag. The console matches on this exhaustively. */
  outcome: Schema.Literal(
    "Succeeded",
    "BusinessOutcome",
    "Escalated",
    "Failed",
    "Running",
    "Recorded"
  ),
  /** The outcome tag or error tag, when there is one. */
  detail: Schema.NullOr(Schema.String),
  durationMs: Schema.NullOr(Schema.Number),
  evidenceRef: Schema.String,
}) {}

/**
 * One run in full: the typed result, plus the evidence trail behind it.
 *
 * `events` is the raw evidence log and `result` is the contract the caller was
 * given. Both, because they answer different questions — "what did this return"
 * and "why should I believe it".
 */
export class RunDetail extends Schema.Class<RunDetail>("RunDetail")({
  summary: RunSummary,
  result: Schema.NullOr(ReplayResult),
  trace: Schema.Array(TraceEvent),
  /** Evidence file names in the run directory, for the viewer to link. */
  artifacts: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      kind: Schema.Literal("screenshot", "json", "log", "other"),
      bytes: Schema.Number,
    })
  ),
}) {}

/** Live session state, so the console can show who is driving what. */
export class SessionView extends Schema.Class<SessionView>("SessionView")({
  sessionId: Schema.String,
  state: ControlState,
  /** Where an operator console connects to co-browse this session. */
  takeoverUrl: Schema.NullOr(Schema.String),
}) {}

/**
 * A capability as a calling agent sees it: a tool declaration.
 *
 * Derived from the artifact rather than written alongside it, so what an agent
 * believes it can do cannot drift from what the system will execute.
 */
export class CapabilityDeclaration extends Schema.Class<CapabilityDeclaration>(
  "CapabilityDeclaration"
)({
  name: Schema.String,
  description: Schema.String,
  /** Plain JSON Schema — what Gemini's `parametersJsonSchema` takes verbatim. */
  parametersJsonSchema: Schema.Unknown,
}) {}

export class ReplayRequestPayload extends Schema.Class<ReplayRequestPayload>(
  "ReplayRequestPayload"
)({
  capability: Schema.String,
  version: Schema.String,
  inputs: Schema.Record({ key: Schema.String, value: Schema.String }),
  baseUrl: Schema.String,
  /**
   * Which institution's variant to run.
   *
   * Resolved through that tenant's overlay before execution. Omitted means the
   * base capability, which is the right answer for an install that matches the
   * vendor's default.
   */
  tenant: Schema.optional(Schema.String),
  /**
   * Wait for a person when the run gets stuck, instead of ending it.
   *
   * The console defaults this on — an operator watching a run *is* the person —
   * while a scheduled caller leaves it off, because a batch job that blocks
   * forever waiting for somebody is worse than one that reports it needed them.
   */
  live: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  /**
   * Screenshot after every step, so a finished run can be looked through.
   *
   * A replay takes about two seconds — it is over before anyone can watch it —
   * and screenshots are otherwise captured only on failure. This trades roughly
   * double the wall time for the ability to see what each screen looked like.
   *
   * Plain `optional` rather than `optionalWith(default)`: a default makes the
   * field optional on the wire but *required* in the type callers construct, so
   * adding one breaks every existing caller. The handler applies the default
   * instead, which is where a default belongs.
   */
  captureSteps: Schema.optional(Schema.Boolean),
}) {}

/**
 * Starting a replay answers immediately with the run id.
 *
 * A replay takes seconds and may pause for a human for minutes; holding an HTTP
 * request open for that is the wrong shape. The console polls the run and, when
 * it pauses, connects to the takeover socket the intervention names.
 */
export class ReplayAccepted extends Schema.Class<ReplayAccepted>(
  "ReplayAccepted"
)({
  runId: Schema.String,
  evidenceRef: Schema.String,
  /**
   * Where to watch this run happen, and — if it pauses — where to drive it.
   *
   * One socket, two privileges: connecting streams the live page, while acting
   * requires claiming an intervention. Watching is therefore safe for anyone
   * with the URL, which is why it is offered for every run rather than only for
   * attended ones.
   */
  takeoverUrl: Schema.NullOr(Schema.String),
}) {}

export class HandbackPayload extends Schema.Class<HandbackPayload>(
  "HandbackPayload"
)({
  operatorId: Schema.String,
  /**
   * `skipStep` when the operator performed the step themselves — the automation
   * must not do it again. `abort` gives up on the run.
   */
  disposition: Schema.Literal("retryStep", "skipStep", "abort"),
  note: Schema.optional(Schema.String),
}) {}

// ── Groups ───────────────────────────────────────────────────────────────

/**
 * The catalog. Also the agent-facing surface: a customer-facing agent asks this
 * what it can do, and gets typed inputs, typed outputs and declared outcomes.
 */
export class CapabilitiesApi extends HttpApiGroup.make("capabilities")
  .add(
    HttpApiEndpoint.get("list", "/capabilities").addSuccess(
      Schema.Array(CapabilitySummary)
    )
  )
  .add(
    HttpApiEndpoint.get("findByName", "/capabilities/:name/:version")
      .setPath(Schema.Struct({ name: Schema.String, version: Schema.String }))
      .setUrlParams(Schema.Struct({ tenant: Schema.optional(Schema.String) }))
      .addSuccess(CapabilityArtifact)
      .addError(CapabilityNotFound, { status: 404 })
  )
  /**
   * The agent-facing view of the whole catalog.
   *
   * One request gives a customer-facing agent every tool it can call, with typed
   * arguments and the declared outcomes it must not treat as errors. This is the
   * endpoint that makes "a capability is a callable function" literal.
   */
  .add(
    HttpApiEndpoint.get("declarations", "/capabilities/declarations").addSuccess(
      Schema.Array(CapabilityDeclaration)
    )
  )
  /** Which institutions this capability has an overlay for. */
  .add(
    HttpApiEndpoint.get("tenants", "/capabilities/:name/:version/tenants")
      .setPath(Schema.Struct({ name: Schema.String, version: Schema.String }))
      .addSuccess(Schema.Array(Schema.String))
      .addError(CapabilityNotFound, { status: 404 })
  )
  .annotateContext(
    OpenApi.annotations({
      title: "Capabilities",
      description: "The compiled artifacts an agent can invoke by name.",
    })
  ) {}

export class RunsApi extends HttpApiGroup.make("runs")
  .add(
    HttpApiEndpoint.get("list", "/runs").addSuccess(Schema.Array(RunSummary))
  )
  .add(
    HttpApiEndpoint.get("findById", "/runs/:runId")
      .setPath(Schema.Struct({ runId: Schema.String }))
      .addSuccess(RunDetail)
      .addError(RunNotFound, { status: 404 })
  )
  .add(
    HttpApiEndpoint.post("start", "/runs")
      .setPayload(ReplayRequestPayload)
      .addSuccess(ReplayAccepted, { status: 202 })
      .addError(CapabilityNotFound, { status: 404 })
      .addError(InvalidInputs, { status: 422 })
  )
  .annotateContext(
    OpenApi.annotations({
      title: "Runs",
      description: "Replays, their typed results, and their evidence.",
    })
  ) {}

/**
 * The operator inbox.
 *
 * `claim` and `resolve` exist over HTTP as well as over the takeover socket
 * because they are decisions about a run, not part of co-browsing: a supervisor
 * can abort an intervention from the inbox without ever opening the screencast.
 */
export class InterventionsApi extends HttpApiGroup.make("interventions")
  .add(
    HttpApiEndpoint.get("list", "/interventions").addSuccess(
      Schema.Array(Intervention)
    )
  )
  .add(
    HttpApiEndpoint.get("findById", "/interventions/:interventionId")
      .setPath(Schema.Struct({ interventionId: Schema.String }))
      .addSuccess(Intervention)
      .addError(InterventionNotFound, { status: 404 })
  )
  .add(
    HttpApiEndpoint.post("claim", "/interventions/:interventionId/claim")
      .setPath(Schema.Struct({ interventionId: Schema.String }))
      .setPayload(Schema.Struct({ operatorId: Schema.String }))
      .addSuccess(SessionView)
      .addError(InterventionNotFound, { status: 404 })
      .addError(ControlRefused, { status: 409 })
  )
  .add(
    HttpApiEndpoint.post("resolve", "/interventions/:interventionId/resolve")
      .setPath(Schema.Struct({ interventionId: Schema.String }))
      .setPayload(HandbackPayload)
      .addSuccess(Intervention)
      .addError(InterventionNotFound, { status: 404 })
      .addError(ControlRefused, { status: 409 })
  )
  .annotateContext(
    OpenApi.annotations({
      title: "Interventions",
      description: "Runs waiting for a person, and how a person answers them.",
    })
  ) {}

export class SessionsApi extends HttpApiGroup.make("sessions")
  .add(
    HttpApiEndpoint.get("list", "/sessions").addSuccess(
      Schema.Array(SessionView)
    )
  )
  .annotateContext(OpenApi.annotations({ title: "Sessions" })) {}

export class CuaApi extends HttpApi.make("CuaApi")
  .add(CapabilitiesApi)
  .add(RunsApi)
  .add(InterventionsApi)
  .add(SessionsApi)
  .prefix("/api")
  .annotateContext(
    OpenApi.annotations({
      title: "Computer-Use Automation",
      description:
        "Discover once, compile to a typed capability, replay deterministically.",
    })
  ) {}
