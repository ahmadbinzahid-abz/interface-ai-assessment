"use client"

import Link from "next/link"
import { Either } from "effect"

import { Badge } from "@workspace/ui/components/badge"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"

import { OutcomeBadge } from "@/components/common/status/outcome-badge"
import {
  ConnectionError,
  LoadingRows,
} from "@/components/common/status/query-states"
import { useRuns } from "../hooks/use-runs"

/**
 * Every run that left evidence behind — discovery and replay alike.
 *
 * They share a list because they share a directory: both write a redacted trace
 * as they go, and an operator asking "what has this system done" wants both
 * answers. They are marked as different *kinds* rather than folded into one
 * status, because a discovery run produced an artifact and a replay produced an
 * answer, and calling those the same thing would be a lie in the column header.
 */
export function RunList() {
  const query = useRuns()

  if (query.isPending) return <LoadingRows />
  if (query.isError)
    return <ConnectionError onRetry={() => void query.refetch()} />

  return Either.match(query.data, {
    onLeft: () => <ConnectionError onRetry={() => void query.refetch()} />,

    onRight: (runs) =>
      runs.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No runs yet</EmptyTitle>
            <EmptyDescription>
              Start one from a capability, or run{" "}
              <code className="font-mono">cua replay</code>.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Capability</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Detail</TableHead>
                <TableHead className="text-right">Took</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.runId}>
                  <TableCell className="font-mono text-xs">
                    <Link
                      href={`/runs/${run.runId}`}
                      className="hover:underline"
                    >
                      {run.runId}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{run.kind}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {run.capability}
                    {run.capabilityVersion ? `@${run.capabilityVersion}` : ""}
                  </TableCell>
                  <TableCell>
                    <OutcomeBadge outcome={run.outcome} />
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground">
                    {run.detail ?? "—"}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {run.durationMs === null
                      ? "—"
                      : `${(run.durationMs / 1000).toFixed(1)}s`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ),
  })
}
