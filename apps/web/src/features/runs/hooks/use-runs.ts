"use client"

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
