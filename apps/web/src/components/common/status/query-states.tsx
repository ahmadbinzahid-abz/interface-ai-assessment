"use client"

import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { Skeleton } from "@workspace/ui/components/skeleton"

/**
 * The transport axis, rendered once.
 *
 * Every screen in this console splits into two questions — did the request get
 * through, and what did the server say — and only the second one is interesting.
 * These cover the first so each screen can spend its code on the second.
 */

export function LoadingRows({ rows = 4 }: { readonly rows?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  )
}

/**
 * The orchestrator is not answering.
 *
 * Named for what it is rather than "error": the most likely cause by far is that
 * nobody started the server, and telling the operator that is more useful than
 * telling them something went wrong.
 */
export function ConnectionError({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Cannot reach the orchestrator</AlertTitle>
      <AlertDescription>
        <p>
          Nothing answered at the API. Start it with{" "}
          <code className="font-mono">pnpm --filter orchestrator dev</code>.
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  )
}
