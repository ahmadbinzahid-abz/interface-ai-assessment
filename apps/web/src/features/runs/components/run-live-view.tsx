"use client"

import Link from "next/link"

import type { ControlState, TraceEvent } from "@workspace/contracts"
import { describeControlState } from "@workspace/contracts"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Spinner } from "@workspace/ui/components/spinner"

import { useTakeover } from "@/features/interventions/live-control/hooks/use-takeover"
import { ScreencastSurface } from "@/features/interventions/live-control/components/screencast-surface"
import { useSessionForRun } from "../hooks/use-runs"

/**
 * Watching a run happen, rather than reading what it did.
 *
 * The same CDP screencast the takeover uses, on the same socket — pointed at a
 * run that has *not* stopped. Nothing new had to be built to make this work,
 * which is the point: connecting to that socket was always read-only, because
 * acting requires holding the control lease and a running automation is holding
 * it. A watcher gets pixels and nothing else, enforced rather than promised.
 *
 * Why it earns its place: a replay finishes in about two seconds and its result
 * is a single line. That is fine when it succeeds and useless when it does not —
 * "TargetNotFound at s7" tells you where it stopped but not what the screen
 * looked like on the way there. Watching turns a verdict into an observation.
 */
export function RunLiveView({
  runId,
  trace,
}: {
  readonly runId: string
  readonly trace: readonly TraceEvent[]
}) {
  const session = useSessionForRun(runId)
  const takeover = useTakeover(session?.takeoverUrl ?? undefined)

  const current = currentStep(trace)

  /**
   * A watched run that has stopped for a person is no longer a thing to watch —
   * it is a thing to answer. Saying "Running" while it waits would be true and
   * would leave somebody staring at a still frame wondering why nothing moves.
   */
  const waiting = pendingIntervention(takeover.state)

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle>{waiting ? "Paused — needs a person" : "Running"}</CardTitle>
          {waiting ? null : <Spinner className="text-muted-foreground" />}
          {takeover.state ? (
            <Badge variant={waiting ? "outline" : "secondary"}>
              {describeControlState(takeover.state)}
            </Badge>
          ) : null}
        </div>
        <CardDescription>
          {current
            ? `${current.stepId} · ${current.intent}`
            : "Waiting for the first step…"}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {session ? (
          <ScreencastSurface
            frame={takeover.frame}
            // Never. The automation holds the lease; the surface would refuse
            // anything sent from here anyway, and offering a cursor that does
            // nothing is worse than offering none.
            driving={false}
            onSend={() => {}}
            idleLabel={
              waiting
                ? "paused — claim it to drive"
                : "watching — the automation is driving"
            }
            waitingLabel="Connecting to the live session…"
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            No live session for this run. It either finished moments ago, or it
            was started outside this orchestrator.
          </p>
        )}

        {waiting ? (
          <Button
            nativeButton={false}
            render={<Link href={`/interventions/${waiting}`} />}
          >
            Take control
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">
            If this run pauses for a person, it will appear in{" "}
            <strong>Interventions</strong> — and the same session becomes
            drivable once you claim it.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

/** The intervention this run is blocked on, if it is blocked on one. */
const pendingIntervention = (
  state: ControlState | undefined
): string | undefined =>
  state?._tag === "AwaitingOperator" || state?._tag === "PauseRequested"
    ? state.interventionId
    : undefined

/** The step the run is on, taken from the last one it announced. */
const currentStep = (
  trace: readonly TraceEvent[]
): { readonly stepId: string; readonly intent: string } | undefined => {
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const event = trace[index]
    if (event?._tag === "StepStarted") {
      return { stepId: event.stepId, intent: event.intent }
    }
  }

  return undefined
}
