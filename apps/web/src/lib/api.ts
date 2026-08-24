import { FetchHttpClient, HttpApiClient, HttpClient } from "@effect/platform"
import { CuaApi } from "@workspace/contracts"
import { Context, Effect, Layer, ManagedRuntime } from "effect"

/**
 * The API client, derived rather than written.
 *
 * There is no SDK in this file — `HttpApiClient.make` takes the same `CuaApi`
 * value the server implements and produces a fully typed client from it. Add an
 * endpoint to the contract and it appears here; change a payload and every
 * caller stops compiling. Nothing to regenerate, and nothing that can go stale.
 *
 * Both channels are typed: `client.runs.findById(...)` succeeds with `RunDetail`
 * and fails with `RunNotFound`, which is what lets the screens below match on
 * the failure exhaustively instead of rendering "something went wrong".
 */

const baseUrl =
  process.env["NEXT_PUBLIC_ORCHESTRATOR_URL"] ?? "http://localhost:4000"

const HttpLive = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.RequestInit, { cache: "no-store" })
  )
)

const make = HttpApiClient.make(CuaApi, {
  baseUrl,
  transformClient: HttpClient.retryTransient({ times: 2 }),
}).pipe(Effect.provide(HttpLive))

export class ApiClient extends Context.Tag("ApiClient")<
  ApiClient,
  Effect.Effect.Success<typeof make>
>() {
  static readonly Live = Layer.effect(this, make)
}

/** One place where effects meet the imperative world. */
export const AppRuntime = ManagedRuntime.make(ApiClient.Live)

/** Where a run's evidence files are served from, for the evidence viewer. */
export const evidenceUrl = (runId: string, file: string): string =>
  `${baseUrl}/evidence/${encodeURIComponent(runId)}/${encodeURIComponent(file)}`
