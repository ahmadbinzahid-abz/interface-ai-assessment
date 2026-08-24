"use client"

import { useState } from "react"
import { Either, Match } from "effect"

import { describeControlState } from "@workspace/contracts"
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Separator } from "@workspace/ui/components/separator"

import { NotFound } from "@/components/common/status/not-found"
import {
  ConnectionError,
  LoadingRows,
} from "@/components/common/status/query-states"
import { evidenceUrl } from "@/lib/api"
import {
  useIntervention,
  useSessionForIntervention,
} from "@/features/interventions/hooks/use-interventions"
import { isDriving, useTakeover } from "../hooks/use-takeover"
import { ScreencastSurface } from "./screencast-surface"

/**
 * Taking control of a paused run.
 *
 * The screen is laid out the way the decision is actually made: the live page on
 * the left, and on the right *why it stopped* — the capability's goal, the step
 * and its English intent, the guardrail's reason, and the screenshot taken at
 * the moment it paused. An intervention that says only "step 8 failed" makes the
 * operator re-derive context the engine already had.
 *
 * The handback buttons are two genuinely different answers, and the wording says
 * which is which. `skipStep` means *I did it* — the automation must not repeat
 * an irreversible action. `retryStep` means *I cleared the way* — the automation
 * should try again, on a screen that has changed.
 */
export function LiveControl({
  interventionId,
}: {
  readonly interventionId: string
}) {
  // In a real deployment this comes from the session. Here it is explicit so
  // that every captured action is still attributed to somebody by name.
  const [operatorId, setOperatorId] = useState("operator")

  const query = useIntervention(interventionId)
  const session = useSessionForIntervention(interventionId)
  const takeover = useTakeover(session?.takeoverUrl ?? undefined)

  const driving = isDriving(takeover.state, operatorId)

  if (query.isPending) return <LoadingRows />
  if (query.isError)
    return <ConnectionError onRetry={() => void query.refetch()} />

  return Either.match(query.data, {
    onLeft: (error) =>
      Match.value(error).pipe(
        Match.tag("InterventionNotFound", () => (
          <NotFound
            title="That intervention is closed"
            description="It was resolved, or the browser session behind it has gone. Interventions do not outlive the page they refer to."
          />
        )),
        Match.orElse(() => (
          <ConnectionError onRetry={() => void query.refetch()} />
        ))
      ),

    onRight: (intervention) => (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-lg font-semibold">Take control</h1>
            <Badge variant="outline">{intervention.trigger}</Badge>
            {takeover.state ? (
              <Badge variant="secondary">
                {describeControlState(takeover.state)}
              </Badge>
            ) : null}
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            {intervention.capability}@{intervention.capabilityVersion} ·{" "}
            {intervention.id}
          </p>
        </div>

        {takeover.denial ? (
          <Alert variant="destructive">
            <AlertTitle>Refused</AlertTitle>
            <AlertDescription>{takeover.denial}</AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
          <div className="flex flex-col gap-3">
            <ScreencastSurface
              frame={takeover.frame}
              driving={driving}
              onSend={takeover.send}
            />

            <div className="flex flex-wrap items-center gap-2">
              {driving ? (
                <>
                  <Button
                    onClick={() =>
                      takeover.send({
                        _tag: "handback",
                        disposition: "skipStep",
                      })
                    }
                  >
                    I did this step — resume
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      takeover.send({
                        _tag: "handback",
                        disposition: "retryStep",
                      })
                    }
                  >
                    I cleared the way — retry
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => takeover.send({ _tag: "abort" })}
                  >
                    Abort the run
                  </Button>
                </>
              ) : (
                <>
                  <input
                    aria-label="Operator id"
                    value={operatorId}
                    onChange={(event) => setOperatorId(event.target.value)}
                    className="h-9 rounded-md border bg-transparent px-3 text-sm"
                  />
                  <Button
                    disabled={!takeover.connected}
                    onClick={() =>
                      takeover.send({
                        _tag: "claim",
                        interventionId,
                        operatorId,
                      })
                    }
                  >
                    Take control
                  </Button>
                </>
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              While you hold this session the automation is <em>refused</em>, not
              merely paused — the surface rejects any command from a run that
              does not hold the lease.
            </p>
          </div>

          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Why it stopped</CardTitle>
                <CardDescription>{intervention.reason}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <Detail label="Goal" value={intervention.goal} />
                <Detail
                  label="Step"
                  value={`${intervention.stepId} · ${intervention.stepIntent}`}
                />
                <Detail
                  label="Raised"
                  value={new Date(intervention.raisedAt).toLocaleString()}
                />

                {intervention.recentActions.length > 0 ? (
                  <>
                    <Separator />
                    <div className="flex flex-col gap-1">
                      <span className="text-muted-foreground">
                        What it did just before
                      </span>
                      <ol className="flex flex-col gap-1">
                        {intervention.recentActions.map((action) => (
                          <li key={action} className="text-xs">
                            {action}
                          </li>
                        ))}
                      </ol>
                    </div>
                  </>
                ) : null}
              </CardContent>
            </Card>

            {intervention.screenshotRef ? (
              <Card>
                <CardHeader>
                  <CardTitle>At the moment it paused</CardTitle>
                  <CardDescription>
                    Redacted when it was written, not when it is shown.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={screenshotHref(
                      intervention.runId,
                      intervention.screenshotRef
                    )}
                    alt="The screen when the run paused"
                    className="w-full rounded-md border"
                  />
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle>What you did</CardTitle>
                <CardDescription>
                  Captured as coordinates for fidelity and as role plus name for
                  review — which is what would let this become a new artifact
                  version.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {takeover.captured.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing yet.
                  </p>
                ) : (
                  <ol className="flex flex-col gap-1 text-sm">
                    {takeover.captured.map((action, index) => (
                      <li key={index} className="flex gap-2">
                        <Badge variant="outline">{action.kind}</Badge>
                        <span className="text-muted-foreground">
                          {action.targetName ||
                            action.text ||
                            action.url ||
                            (action.point
                              ? `(${action.point.x}, ${action.point.y})`
                              : "")}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    ),
  })
}

/**
 * The intervention records an absolute path on the machine that wrote it; the
 * evidence route addresses files by run and name. Taking the basename is the
 * whole conversion.
 */
const screenshotHref = (runId: string, absolutePath: string): string =>
  evidenceUrl(runId, absolutePath.split(/[\\/]/).pop() ?? "")

function Detail({
  label,
  value,
}: {
  readonly label: string
  readonly value: string
}) {
  return (
    <div className="flex gap-3">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <span className="break-words">{value}</span>
    </div>
  )
}
