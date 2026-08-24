"use client"

import Link from "next/link"
import { Match } from "effect"

import type { ReplayError, ReplayResult } from "@workspace/contracts"
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"

/**
 * The result union, rendered branch by branch.
 *
 * This component is where the central design claim becomes visible: `Succeeded`,
 * `BusinessOutcome`, `Escalated` and `Failed` are four *different things*, and
 * the console says so. A business outcome gets a neutral card, not a red one —
 * "no such member" is the application answering, and a console that alarms about
 * it trains its operators to ignore the alarms that matter.
 *
 * `Match.exhaustive` means adding a fifth branch to the union breaks this build
 * until somebody decides what it looks like.
 */
export function ReplayResultView({
  result,
}: {
  readonly result: ReplayResult
}) {
  return Match.value(result).pipe(
    Match.tag("Succeeded", (succeeded) => (
      <Card>
        <CardHeader>
          <CardTitle>Succeeded</CardTitle>
          <CardDescription>
            {succeeded.summary.stepsAttempted} steps in{" "}
            {(succeeded.summary.durationMs / 1000).toFixed(1)}s, no model
            involved.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {Object.entries(succeeded.outputs).map(([name, value]) => (
            <div key={name} className="flex items-baseline gap-3">
              <span className="w-40 shrink-0 text-sm text-muted-foreground">
                {name}
              </span>
              <span className="font-mono text-sm">{String(value)}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    )),

    Match.tag("BusinessOutcome", (outcome) => (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <CardTitle>{outcome.outcome}</CardTitle>
            <Badge variant="secondary">business outcome</Badge>
          </div>
          <CardDescription>{outcome.detail}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <p className="text-muted-foreground">
            The application answered, and this is the answer. It is not a
            failure, and retrying it would never produce a different result —
            which is exactly why the caller receives it as typed data rather than
            as an error.
          </p>
          <p className="text-muted-foreground">
            Detected at step{" "}
            <span className="font-mono">{outcome.atStepId}</span>.
          </p>
        </CardContent>
      </Card>
    )),

    Match.tag("Escalated", (escalated) => (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <CardTitle>Escalated</CardTitle>
            <Badge variant="outline">needs a person</Badge>
          </div>
          <CardDescription>{escalated.reason}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
          <p>
            Stopped at step{" "}
            <span className="font-mono">{escalated.atStepId}</span>.
          </p>
          <p>
            Intervention{" "}
            <Link
              href={`/interventions/${escalated.interventionId}`}
              className="font-mono underline"
            >
              {escalated.interventionId}
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    )),

    Match.tag("Failed", (failed) => (
      <Alert variant="destructive">
        <AlertTitle>Failed — {failed.error._tag}</AlertTitle>
        <AlertDescription>
          <FailureDetail error={failed.error} />
        </AlertDescription>
      </Alert>
    )),

    Match.exhaustive
  )
}

/**
 * What went wrong, in enough detail to debug without re-running it.
 *
 * Every branch of the taxonomy carries different evidence — which strategies
 * were tried, what was expected against what was observed, how many times
 * re-authentication was attempted — and showing the right fields per variant is
 * the whole reason the errors are separate types rather than one message string.
 */
function FailureDetail({ error }: { readonly error: ReplayError }) {
  return Match.value(error).pipe(
    Match.tag("InputValidationFailed", (invalid) => (
      <ul>
        {invalid.issues.map((issue) => (
          <li key={issue}>{issue}</li>
        ))}
      </ul>
    )),

    Match.tag("TargetNotFound", (notFound) => (
      <p>
        Nothing matched <em>{notFound.targetDescription}</em> at step{" "}
        <span className="font-mono">{notFound.stepId}</span> after{" "}
        {notFound.strategiesTried} ranked strategies. This is what UI drift looks
        like.
      </p>
    )),

    Match.tag("AmbiguousTarget", (ambiguous) => (
      <p>
        <em>{ambiguous.targetDescription}</em> matched {ambiguous.matchCount}{" "}
        controls at step{" "}
        <span className="font-mono">{ambiguous.stepId}</span>. Acting on the
        wrong one is worse than not acting, so the run stopped.
      </p>
    )),

    Match.tag("CheckpointFailed", (checkpoint) => (
      <div className="flex flex-col gap-1">
        <p>
          Step <span className="font-mono">{checkpoint.stepId}</span> ran, but
          the world did not end up where the artifact expected.
        </p>
        <p>expected · {checkpoint.expected}</p>
        <p>observed · {checkpoint.observed}</p>
      </div>
    )),

    Match.tag("StepTimeout", (timeout) => (
      <p>
        Step <span className="font-mono">{timeout.stepId}</span> never settled
        after {timeout.waitedMs}ms.
      </p>
    )),

    Match.tag("PolicyDenied", (denied) => (
      <p>
        The guardrail refused step{" "}
        <span className="font-mono">{denied.stepId}</span> under rule{" "}
        <span className="font-mono">{denied.rule}</span>: {denied.reason}. This
        is the system working.
      </p>
    )),

    Match.tag("SessionExpiredUnrecoverable", (expired) => (
      <p>
        The session expired at step{" "}
        <span className="font-mono">{expired.stepId}</span> and{" "}
        {expired.reauthAttempts} re-authentication attempt(s) did not restore it.
      </p>
    )),

    Match.tag("UnexpectedDialog", (dialog) => (
      <p>
        An undeclared dialog appeared at step{" "}
        <span className="font-mono">{dialog.stepId}</span>: “{dialog.dialogText}
        ”.
      </p>
    )),

    Match.tag("ApplicationError", (application) => (
      <p>
        The application itself broke at step{" "}
        <span className="font-mono">{application.stepId}</span>:{" "}
        {application.detail}
      </p>
    )),

    Match.tag("SurfaceUnavailable", (surface) => (
      <p>
        The browser or adapter died{" "}
        {surface.stepId ? (
          <>
            at step <span className="font-mono">{surface.stepId}</span>
          </>
        ) : null}
        : {surface.detail}
      </p>
    )),

    Match.exhaustive
  )
}
