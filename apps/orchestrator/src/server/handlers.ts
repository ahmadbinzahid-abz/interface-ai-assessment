import {
  CapabilityDeclaration,
  CapabilityNotFound,
  ControlRefused,
  CuaApi,
  InterventionNotFound,
  InvalidInputs,
  ReplayAccepted,
  RunNotFound,
} from "@workspace/contracts"
import { HttpApiBuilder } from "@effect/platform"
import { declarationsFor, validateInputs } from "@workspace/engine"
import { Effect, Layer } from "effect"

import type { Orchestrator } from "./orchestrator.js"
import {
  findRun,
  listCapabilities,
  listOverlayTenants,
  listRuns,
  readCapability,
  readCapabilityForTenant,
} from "./repositories.js"

/**
 * Handlers implement the contract; they do not describe it.
 *
 * The compiler rejects a handler that returns the wrong shape, fails with an
 * error the endpoint never declared, or forgets an endpoint in its group. That
 * is the whole reason the API is a value: there is no route registration that
 * can quietly disagree with what the client was told.
 */

export const makeApiLayer = (orchestrator: Orchestrator) => {
  const capabilities = HttpApiBuilder.group(CuaApi, "capabilities", (handlers) =>
    handlers
      .handle("list", () => listCapabilities())
      .handle("findByName", ({ path, urlParams }) =>
        Effect.gen(function* () {
          // With `?tenant=`, the artifact returned is the *resolved* one — what
          // would actually execute against that institution, not the base the
          // reviewer would have to merge in their head.
          const artifact = yield* readCapabilityForTenant(
            path.name,
            path.version,
            urlParams.tenant
          )

          if (!artifact) {
            return yield* new CapabilityNotFound({
              name: path.name,
              version: path.version,
            })
          }

          return artifact
        })
      )
      .handle("declarations", () =>
        Effect.gen(function* () {
          const summaries = yield* listCapabilities()

          const artifacts = yield* Effect.forEach(summaries, (summary) =>
            readCapability(summary.name, summary.version)
          )

          return declarationsFor(
            artifacts.filter(
              (artifact): artifact is NonNullable<typeof artifact> =>
                artifact !== undefined
            )
          ).map(
            (declaration) =>
              new CapabilityDeclaration({
                name: declaration.name,
                description: declaration.description,
                parametersJsonSchema: declaration.parametersJsonSchema,
              })
          )
        })
      )
      .handle("tenants", ({ path }) =>
        Effect.gen(function* () {
          const artifact = yield* readCapability(path.name, path.version)

          if (!artifact) {
            return yield* new CapabilityNotFound({
              name: path.name,
              version: path.version,
            })
          }

          return yield* listOverlayTenants(path.name, path.version)
        })
      )
  )

  const runs = HttpApiBuilder.group(CuaApi, "runs", (handlers) =>
    handlers
      .handle("list", () => listRuns())
      .handle("findById", ({ path }) =>
        Effect.gen(function* () {
          const run = yield* findRun(path.runId)
          if (!run) return yield* new RunNotFound({ runId: path.runId })
          return run
        })
      )
      .handle("start", ({ payload }) =>
        Effect.gen(function* () {
          const artifact = yield* readCapabilityForTenant(
            payload.capability,
            payload.version,
            payload.tenant
          )

          if (!artifact) {
            return yield* new CapabilityNotFound({
              name: payload.capability,
              version: payload.version,
            })
          }

          /**
           * Validated before a browser is opened.
           *
           * The same function the executor runs, called earlier so the caller
           * gets a 422 with the issues in it instead of a run that launches
           * Chromium and fails on its first step. Cheap, and it keeps the
           * console's form errors identical to the engine's.
           */
          const issues = validateInputs(artifact, payload.inputs)
          if (issues.length > 0) {
            return yield* new InvalidInputs({ issues })
          }

          const started = yield* Effect.promise(() =>
            orchestrator.start({
              artifact,
              inputs: payload.inputs,
              baseUrl: payload.baseUrl,
              live: payload.live,
            })
          )

          return new ReplayAccepted({
            runId: started.runId,
            evidenceRef: started.evidenceRef,
            takeoverUrl: started.takeoverUrl,
          })
        })
      )
  )

  const interventions = HttpApiBuilder.group(
    CuaApi,
    "interventions",
    (handlers) =>
      handlers
        .handle("list", () => Effect.sync(() => orchestrator.interventions()))
        .handle("findById", ({ path }) =>
          Effect.gen(function* () {
            const intervention = orchestrator.intervention(path.interventionId)

            if (!intervention) {
              return yield* new InterventionNotFound({
                interventionId: path.interventionId,
              })
            }

            return intervention
          })
        )
        .handle("claim", ({ path, payload }) =>
          Effect.gen(function* () {
            const intervention = orchestrator.intervention(path.interventionId)

            if (!intervention) {
              return yield* new InterventionNotFound({
                interventionId: path.interventionId,
              })
            }

            const claimed = orchestrator.claim(
              path.interventionId,
              payload.operatorId
            )

            // Refused by the state machine — somebody else is driving. A
            // distinct error from "no such intervention", because the operator
            // can do something about one of them and not the other.
            if (!claimed.ok) {
              return yield* new ControlRefused({ reason: claimed.reason })
            }

            const view = orchestrator.sessionViewFor(path.interventionId)
            if (!view) {
              return yield* new ControlRefused({
                reason: "The session backing this intervention is gone.",
              })
            }

            return view
          })
        )
        .handle("resolve", ({ path, payload }) =>
          Effect.gen(function* () {
            const before = orchestrator.intervention(path.interventionId)

            if (!before) {
              return yield* new InterventionNotFound({
                interventionId: path.interventionId,
              })
            }

            const resolved = orchestrator.resolve(
              path.interventionId,
              payload.disposition,
              payload.note
            )

            if (!resolved.ok) {
              return yield* new ControlRefused({ reason: resolved.reason })
            }

            // Read back after resolving: the registry stamps who decided, when,
            // and the operator action log, and the caller should see that rather
            // than the record as it was before they acted.
            return orchestrator.intervention(path.interventionId) ?? before
          })
        )
  )

  const sessions = HttpApiBuilder.group(CuaApi, "sessions", (handlers) =>
    handlers.handle("list", () => Effect.sync(() => orchestrator.sessions()))
  )

  return HttpApiBuilder.api(CuaApi).pipe(
    Layer.provide([capabilities, runs, interventions, sessions])
  )
}
