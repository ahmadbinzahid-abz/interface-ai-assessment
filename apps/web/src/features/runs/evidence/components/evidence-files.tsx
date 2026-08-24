"use client"

import type { RunDetail } from "@workspace/contracts"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/empty"

import { evidenceUrl } from "@/lib/api"

/**
 * The files a run left behind.
 *
 * Screenshots are shown rather than linked, because the moment somebody opens
 * this tab they are asking "what did the screen look like" — and the answer to
 * that is the picture, not a filename.
 *
 * Everything here was redacted on the way *in*, by the evidence writer, not on
 * the way out to this page. That ordering is the point: there is no code path
 * that puts unredacted evidence on disk and then relies on a viewer to hide it.
 */
export function EvidenceFiles({
  runId,
  artifacts,
}: {
  readonly runId: string
  readonly artifacts: RunDetail["artifacts"]
}) {
  const screenshots = artifacts.filter((file) => file.kind === "screenshot")
  const others = artifacts.filter((file) => file.kind !== "screenshot")

  if (artifacts.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No evidence files</EmptyTitle>
          <EmptyDescription>
            This run wrote no artefacts beyond its trace.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {screenshots.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {screenshots.map((file) => (
            <figure key={file.name} className="flex flex-col gap-2">
              {/*
                A plain <img>: these are arbitrary local PNGs served by the
                orchestrator, not assets Next can optimise ahead of time.
              */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={evidenceUrl(runId, file.name)}
                alt={file.name}
                className="w-full rounded-md border"
              />
              <figcaption className="font-mono text-xs text-muted-foreground">
                {file.name}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : null}

      <ul className="flex flex-col gap-1 text-sm">
        {others.map((file) => (
          <li key={file.name} className="flex items-baseline gap-3">
            <a
              href={evidenceUrl(runId, file.name)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-xs underline"
            >
              {file.name}
            </a>
            <span className="text-xs text-muted-foreground">
              {(file.bytes / 1024).toFixed(1)} kB
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
