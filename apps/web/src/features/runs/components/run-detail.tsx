"use client"

import { Either, Match } from "effect"

import { Badge } from "@workspace/ui/components/badge"
import { Spinner } from "@workspace/ui/components/spinner"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs"

import { NotFound } from "@/components/common/status/not-found"
import { OutcomeBadge } from "@/components/common/status/outcome-badge"
import {
  ConnectionError,
  LoadingRows,
} from "@/components/common/status/query-states"
import { EvidenceFiles } from "@/features/runs/evidence/components/evidence-files"
import { Filmstrip } from "@/features/runs/evidence/components/filmstrip"
import { TraceTimeline } from "@/features/runs/evidence/components/trace-timeline"
import { ReplayResultView } from "./replay-result-view"
import { RunLiveView } from "./run-live-view"
import { useRun } from "../hooks/use-runs"

/**
 * One run: what it answered, and why you should believe it.
 *
 * The result and the trace are separate tabs because they answer separate
 * questions. A caller only needs the first. An auditor, or anybody debugging a
 * failure, needs the second — and needs it to say *why* each step ran, not
 * merely that it did.
 */
export function RunDetailView({ runId }: { readonly runId: string }) {
  const query = useRun(runId)

  if (query.isPending) return <LoadingRows />
  if (query.isError)
    return <ConnectionError onRetry={() => void query.refetch()} />

  return Either.match(query.data, {
    onLeft: (error) =>
      Match.value(error).pipe(
        Match.tag("RunNotFound", (notFound) => (
          <NotFound
            title={`No run ${notFound.runId}`}
            description="Nothing in evidence/ matches that run id."
          />
        )),
        Match.orElse(() => (
          <ConnectionError onRetry={() => void query.refetch()} />
        ))
      ),

    onRight: (run) => {
      const hasFrames = run.artifacts.some((file) =>
        file.name.startsWith("step-")
      )

      return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-mono text-lg font-semibold">{run.summary.runId}</h1>
            <OutcomeBadge outcome={run.summary.outcome} />
            <Badge variant="outline">{run.summary.kind}</Badge>
            {run.summary.outcome === "Running" ? (
              <Spinner className="text-muted-foreground" />
            ) : null}
          </div>
          <p className="font-mono text-sm text-muted-foreground">
            {run.summary.capability}
            {run.summary.capabilityVersion
              ? `@${run.summary.capabilityVersion}`
              : ""}
          </p>
        </div>

        {/*
          While the run is in flight the live view *is* the content, so it sits
          above the tabs rather than behind one. It disappears the moment the run
          ends, because there is nothing live left to watch and the evidence is
          what remains.
        */}
        {run.summary.outcome === "Running" ? (
          <RunLiveView runId={run.summary.runId} trace={run.trace} />
        ) : null}

        <Tabs defaultValue={run.summary.outcome === "Running" ? "trace" : "result"}>
          <TabsList>
            <TabsTrigger value="result">Result</TabsTrigger>
            <TabsTrigger value="trace">Trace</TabsTrigger>
            {hasFrames ? (
              <TabsTrigger value="filmstrip">Filmstrip</TabsTrigger>
            ) : null}
            <TabsTrigger value="evidence">Evidence</TabsTrigger>
          </TabsList>

          <TabsContent value="result" className="pt-4">
            {run.result ? (
              <ReplayResultView result={run.result} />
            ) : (
              <p className="text-sm text-muted-foreground">
                {/*
                  No result file yet. For a replay that means it is still going;
                  for a discovery run it means there is no replay result to have
                  — the output was an artifact.
                */}
                {run.summary.kind === "discovery"
                  ? "A discovery run produces an artifact rather than an answer. Its recording is in the evidence tab."
                  : "The result is written when the run finishes. Until then, watch it above and follow the steps in the trace."}
              </p>
            )}
          </TabsContent>

          <TabsContent value="trace" className="pt-4">
            <TraceTimeline trace={run.trace} />
          </TabsContent>

          {hasFrames ? (
            <TabsContent value="filmstrip" className="pt-4">
              <Filmstrip
                runId={run.summary.runId}
                artifacts={run.artifacts}
                trace={run.trace}
              />
            </TabsContent>
          ) : null}

          <TabsContent value="evidence" className="pt-4">
            <EvidenceFiles runId={run.summary.runId} artifacts={run.artifacts} />
          </TabsContent>
        </Tabs>
      </div>
      )
    },
  })
}
