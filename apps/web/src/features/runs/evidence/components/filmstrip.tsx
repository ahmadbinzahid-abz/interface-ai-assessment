"use client"

import type { RunDetail, TraceEvent } from "@workspace/contracts"
import { Badge } from "@workspace/ui/components/badge"

import { evidenceUrl } from "@/lib/api"

/**
 * A finished run, frame by frame.
 *
 * Watching a replay live only works if you are already looking when it starts,
 * and a replay takes about two seconds. This is the answer for every other
 * case: the screens the run actually saw, in order, each captioned with the
 * step's own English intent.
 *
 * The pairing is the whole value. A screenshot on its own shows a page; a
 * screenshot next to *"Entering the member ID to search for the member"* shows
 * whether the automation was doing what it believed it was doing. That is the
 * question you are really asking when a run surprises you.
 */

/** `step-s5.png` → `s5`. Anything else is not a step frame. */
const stepIdOf = (fileName: string): string | undefined => {
  const match = /^step-(.+)\.png$/.exec(fileName)
  return match?.[1]
}

const intentsFrom = (
  trace: readonly TraceEvent[]
): ReadonlyMap<string, string> => {
  const intents = new Map<string, string>()

  for (const event of trace) {
    if (event._tag === "StepStarted") intents.set(event.stepId, event.intent)
  }

  return intents
}

export function Filmstrip({
  runId,
  artifacts,
  trace,
}: {
  readonly runId: string
  readonly artifacts: RunDetail["artifacts"]
  readonly trace: readonly TraceEvent[]
}) {
  const intents = intentsFrom(trace)

  /**
   * Ordered by the trace, not by filename.
   *
   * `s10` sorts before `s2` alphabetically, and a filmstrip in the wrong order
   * is worse than none — it would show a run doing things it never did.
   */
  const order = [...intents.keys()]

  const frames = artifacts
    .map((file) => ({ file, stepId: stepIdOf(file.name) }))
    .filter(
      (entry): entry is { file: RunDetail["artifacts"][number]; stepId: string } =>
        entry.stepId !== undefined
    )
    .sort((a, b) => order.indexOf(a.stepId) - order.indexOf(b.stepId))

  if (frames.length === 0) return null

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {frames.length} frames, one per completed step &mdash; captured because
        this run was started with &ldquo;screenshot every step&rdquo;.
      </p>

      <ol className="grid gap-5 sm:grid-cols-2">
        {frames.map(({ file, stepId }) => (
          <li key={file.name} className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Badge variant="outline">{stepId}</Badge>
              <span className="text-sm">
                {intents.get(stepId) ?? "no recorded intent"}
              </span>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={evidenceUrl(runId, file.name)}
              alt={`The screen after step ${stepId}`}
              className="w-full rounded-md border"
              loading="lazy"
            />
          </li>
        ))}
      </ol>
    </div>
  )
}
