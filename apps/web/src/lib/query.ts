"use client"

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query"
import { Effect, Either } from "effect"

import { ApiClient, AppRuntime } from "@/lib/api"

/**
 * The seam between the typed contract and React.
 *
 * One line does the important work: `Effect.either` turns a typed failure into a
 * *value in the success channel*. Query libraries type `error` as `unknown`, so
 * a domain failure that travelled through it would arrive at the component with
 * its type erased — and the screen would fall back to "something went wrong" for
 * a 404 the contract described precisely.
 *
 * Carrying it through `data` instead keeps the two axes separate, which is the
 * whole point:
 *
 *   `isPending` / `isError`   transport — in flight, network down
 *   `Either.left`             domain — the server answered, and the answer was
 *                             `RunNotFound`
 *
 * Conflating them is why so many consoles show a spinner forever, or an alarming
 * red banner for a perfectly ordinary "no such member".
 */

type Client = Effect.Effect.Success<typeof ApiClient>

export const useApiQuery = <A, E>(
  key: readonly unknown[],
  call: (client: Client) => Effect.Effect<A, E>,
  options: {
    /**
     * A number polls forever. A function is given the last answer and decides,
     * which is what lets a screen stop polling something that has finished — a
     * completed run does not change again, and polling it until the tab closes
     * is pure waste.
     */
    readonly refetchInterval?:
      | number
      | ((data: Either.Either<A, E> | undefined) => number | false)
    readonly enabled?: boolean
  } = {}
): UseQueryResult<Either.Either<A, E>> =>
  useQuery({
    queryKey: key,
    enabled: options.enabled ?? true,
    refetchInterval:
      typeof options.refetchInterval === "function"
        ? (query) =>
            (
              options.refetchInterval as (
                data: Either.Either<A, E> | undefined
              ) => number | false
            )(query.state.data)
        : options.refetchInterval,
    queryFn: () =>
      Effect.gen(function* () {
        const client = yield* ApiClient
        return yield* call(client)
      }).pipe(Effect.either, AppRuntime.runPromise),
  })

export const useApiMutation = <A, E, Input>(
  call: (client: Client, input: Input) => Effect.Effect<A, E>,
  options: {
    /** Query keys to invalidate once the request completes, either way. */
    readonly invalidates?: readonly (readonly unknown[])[]
    readonly onResult?: (result: Either.Either<A, E>) => void
  } = {}
): UseMutationResult<Either.Either<A, E>, Error, Input> => {
  const queries = useQueryClient()

  return useMutation({
    mutationFn: (input: Input) =>
      Effect.gen(function* () {
        const client = yield* ApiClient
        return yield* call(client, input)
      }).pipe(Effect.either, AppRuntime.runPromise),

    /**
     * `onSuccess` fires for both branches, because it means *the request
     * completed*. Which branch it was is in the `Either`, where the type is.
     */
    onSuccess: (result) => {
      for (const key of options.invalidates ?? []) {
        void queries.invalidateQueries({ queryKey: key })
      }
      options.onResult?.(result)
    },
  })
}

export const queryKeys = {
  capabilities: ["capabilities"] as const,
  capability: (name: string, version: string) =>
    ["capabilities", name, version] as const,
  runs: ["runs"] as const,
  run: (runId: string) => ["runs", runId] as const,
  interventions: ["interventions"] as const,
  intervention: (id: string) => ["interventions", id] as const,
  sessions: ["sessions"] as const,
}
