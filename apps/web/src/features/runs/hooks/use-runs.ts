"use client"

import type { ControlState, SessionView } from "@workspace/contracts"

import { queryKeys, useApiQuery } from "@/lib/query"

/**
 * A run in flight has no result yet, so the list polls.
 *
 * Three seconds rather than a socket: the run list is a summary, not a control
 * surface, and a second WebSocket to keep it fresh would add a failure mode for
 * very little. The live control screen, where latency actually matters, gets the
 * socket.
 */
export const useRuns = () =>
  useApiQuery(queryKeys.runs, (client) => client.runs.list(), {
    refetchInterval: 3_000,
  })

/**
 * Polls only while the run is still going.
 *
 * A finished run is immutable — its result file is written once — so continuing
 * to ask about it is waste, and on the live-control screen it is waste competing
 * with a screencast for the same connection.
 */
export const useRun = (runId: string) =>
  useApiQuery(
    queryKeys.run(runId),
    (client) => client.runs.findById({ path: { runId } }),
    {
      refetchInterval: (data) =>
        data?._tag === "Right" && data.right.summary.outcome !== "Running"
          ? false
          : 2_000,
    }
  )

/**
 * The live session driving this run right now, if it is still running.
 *
 * Matched on `runId`, which the control state carries — the same id the evidence
 * directory is named after, so there is one name for the run and no lookup table
 * to keep in step.
 *
 * Returns undefined the moment the run ends, because the session closes with it.
 * That is the correct behaviour rather than a gap: there is nothing live left to
 * watch, and the evidence is what remains.
 */
export const useSessionForRun = (
  runId: string,
  options: { readonly enabled?: boolean } = {}
): SessionView | undefined => {
  const query = useApiQuery(
    queryKeys.sessions,
    (client) => client.sessions.list(),
    { enabled: options.enabled ?? true, refetchInterval: 3_000 }
  )

  if (query.data?._tag !== "Right") return undefined

  return query.data.right.find((session) => runIdOf(session.state) === runId)
}

/** Which run a control state belongs to, in every state that names one. */
const runIdOf = (state: ControlState): string | undefined =>
  state._tag === "Idle" ? undefined : state.runId
