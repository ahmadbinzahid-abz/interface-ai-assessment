"use client"

import Link from "next/link"
import { Either, Match } from "effect"

import { Badge } from "@workspace/ui/components/badge"
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

import { CapabilityStatusBadge } from "@/components/common/status/outcome-badge"
import {
  ConnectionError,
  LoadingRows,
} from "@/components/common/status/query-states"
import { useCapabilities } from "../hooks/use-capabilities"

/**
 * The catalog: what an agent can call, and what it will get back.
 *
 * Each card is the calling contract rather than a description — declared inputs,
 * declared outputs, and the non-success answers the caller is entitled to. That
 * last row is the one worth having: it is the difference between an integration
 * that knows "no such member" is a legitimate reply and one that pages somebody.
 */
export function CapabilityList() {
  const query = useCapabilities()

  // ── transport ──────────────────────────────────────────────────────────
  if (query.isPending) return <LoadingRows />
  if (query.isError) return <ConnectionError onRetry={() => void query.refetch()} />

  // ── domain ─────────────────────────────────────────────────────────────
  return Either.match(query.data, {
    onLeft: (error) =>
      Match.value(error).pipe(
        Match.orElse(() => (
          <ConnectionError onRetry={() => void query.refetch()} />
        ))
      ),

    onRight: (capabilities) =>
      capabilities.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No capabilities yet</EmptyTitle>
            <EmptyDescription>
              Record one with{" "}
              <code className="font-mono">cua discover</code>. Compiled artifacts
              land in <code className="font-mono">capabilities/</code>.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {capabilities.map((capability) => (
            <Card key={`${capability.name}@${capability.version}`}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <CardTitle className="font-mono text-sm">
                    <Link
                      href={`/capabilities/${capability.name}/${capability.version}`}
                      className="hover:underline"
                    >
                      {capability.name}
                    </Link>
                  </CardTitle>
                  <CapabilityStatusBadge status={capability.status} />
                </div>
                <CardDescription>{capability.description}</CardDescription>
              </CardHeader>

              <CardContent className="flex flex-col gap-3 text-xs">
                <ContractRow label="in" names={capability.inputNames} />
                <ContractRow label="out" names={capability.outputNames} />
                <ContractRow
                  label="outcomes"
                  names={capability.outcomeTags}
                  empty="none declared"
                />
              </CardContent>

              <CardFooter className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span>v{capability.version}</span>
                <span>{capability.stepCount} steps</span>
                <span>{capability.vendorProduct}</span>
                {capability.replays > 0 ? (
                  <span>
                    {capability.successes}/{capability.replays} replays
                  </span>
                ) : null}
                <DriftIndicator rate={capability.worstFallbackRate} />
              </CardFooter>
            </Card>
          ))}
        </div>
      ),
  })
}

function ContractRow({
  label,
  names,
  empty = "—",
}: {
  readonly label: string
  readonly names: readonly string[]
  readonly empty?: string
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1">
        {names.length === 0 ? (
          <span className="text-muted-foreground">{empty}</span>
        ) : (
          names.map((name) => (
            <Badge key={name} variant="outline">
              {name}
            </Badge>
          ))
        )}
      </div>
    </div>
  )
}

/**
 * The drift alarm, as one number.
 *
 * A step that used to resolve by role and now resolves by its markup fallback
 * still passes — which is exactly why it needs surfacing. It is the earliest
 * warning that this install's UI has moved, and it arrives long before the
 * capability actually breaks.
 */
function DriftIndicator({ rate }: { readonly rate: number }) {
  if (rate <= 0) return null

  return (
    <Badge variant={rate > 0.5 ? "destructive" : "secondary"}>
      {Math.round(rate * 100)}% fallback
    </Badge>
  )
}
