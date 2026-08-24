"use client"

import type { ControlState, SessionView } from "@workspace/contracts"

import { queryKeys, useApiMutation, useApiQuery } from "@/lib/query"

export const useInterventions = () =>
  useApiQuery(queryKeys.interventions, (client) => client.interventions.list(), {
    refetchInterval: 3_000,
  })

export const useIntervention = (interventionId: string) =>
  useApiQuery(
    queryKeys.intervention(interventionId),
    (client) => client.interventions.findById({ path: { interventionId } }),
    { refetchInterval: 3_000 }
  )

/** The intervention this control state is blocked on, if any. */
const interventionIdOf = (state: ControlState): string | undefined =>
  state._tag === "PauseRequested" ||
  state._tag === "AwaitingOperator" ||
  state._tag === "OperatorDriving" ||
  state._tag === "HandbackRequested"
    ? state.interventionId
    : undefined

/**
 * Which live session is holding this intervention open.
 *
 * The console needs it for one thing: the takeover URL. Each session opens its
 * own socket rather than sharing one on the API server, so a browser that has
 * gone away takes its socket with it instead of leaving a dead path behind.
 */
export const useSessionForIntervention = (
  interventionId: string
): SessionView | undefined => {
  const query = useApiQuery(
    queryKeys.sessions,
    (client) => client.sessions.list(),
    { refetchInterval: 3_000 }
  )

  if (query.data?._tag !== "Right") return undefined

  return query.data.right.find(
    (session) => interventionIdOf(session.state) === interventionId
  )
}

/**
 * Resolving over HTTP rather than over the takeover socket.
 *
 * Both exist because they are different acts. Handing back *through* the
 * screencast is what an operator who just finished driving does; resolving from
 * the inbox is what a supervisor does to a run they never opened. The registry
 * is the single thing that decides whether either is allowed.
 */
export const useResolveIntervention = (interventionId: string) =>
  useApiMutation(
    (
      client,
      payload: {
        operatorId: string
        disposition: "retryStep" | "skipStep" | "abort"
        note?: string
      }
    ) =>
      client.interventions.resolve({ path: { interventionId }, payload }),
    {
      invalidates: [
        queryKeys.interventions,
        queryKeys.intervention(interventionId),
        queryKeys.sessions,
        queryKeys.runs,
      ],
    }
  )
