"use client"

import Link from "next/link"
import { Either } from "effect"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/empty"

import {
  ConnectionError,
  LoadingRows,
} from "@/components/common/status/query-states"
import { useInterventions } from "../hooks/use-interventions"

/**
 * The queue of runs waiting on a person.
 *
 * Grouped by *why* rather than listed flat, because the two reasons need
 * different people. `policyRequiresApproval` is the designed path — the
 * guardrail refused an irreversible action and wants a human to take it, which
 * is a banking decision. `targetNotFound` means the UI moved, which is an
 * engineering signal and the seed of the next artifact version. An inbox that
 * cannot tell them apart is a log file.
 */
export function InterventionInbox() {
  const query = useInterventions()

  if (query.isPending) return <LoadingRows />
  if (query.isError)
    return <ConnectionError onRetry={() => void query.refetch()} />

  return Either.match(query.data, {
    onLeft: () => <ConnectionError onRetry={() => void query.refetch()} />,

    onRight: (interventions) => {
      const open = interventions.filter(
        (intervention) => intervention.status !== "resolved"
      )

      if (open.length === 0) {
        return (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Nothing is waiting</EmptyTitle>
              <EmptyDescription>
                Runs appear here when the guardrail wants a person, or when a
                capability can no longer find something it was recorded against.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )
      }

      return (
        <div className="flex flex-col gap-4">
          {open.map((intervention) => (
            <Card key={intervention.id}>
              <CardHeader>
                <div className="flex flex-wrap items-center gap-3">
                  <CardTitle className="font-mono text-sm">
                    {intervention.capability}@{intervention.capabilityVersion}
                  </CardTitle>
                  <Badge variant="outline">{intervention.trigger}</Badge>
                  {intervention.status === "claimed" ? (
                    <Badge variant="secondary">
                      {intervention.claimedBy} is driving
                    </Badge>
                  ) : null}
                </div>
                <CardDescription>{intervention.reason}</CardDescription>
              </CardHeader>

              <CardContent className="flex flex-col gap-1 text-sm text-muted-foreground">
                <p>
                  step <span className="font-mono">{intervention.stepId}</span> ·{" "}
                  {intervention.stepIntent}
                </p>
                <p>{intervention.goal}</p>
              </CardContent>

              <CardFooter className="flex items-center gap-3">
                {/*
                  `nativeButton={false}` because this renders an anchor. Base UI
                  warns otherwise, and it is right to: a link that claims native
                  button semantics behaves wrongly for keyboards and forms.
                */}
                <Button
                  nativeButton={false}
                  render={<Link href={`/interventions/${intervention.id}`} />}
                >
                  Open the live session
                </Button>
                <span className="text-xs text-muted-foreground">
                  raised {new Date(intervention.raisedAt).toLocaleTimeString()}
                </span>
              </CardFooter>
            </Card>
          ))}
        </div>
      )
    },
  })
}
