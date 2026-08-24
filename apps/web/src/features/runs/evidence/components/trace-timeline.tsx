"use client"

import { Match } from "effect"

import type { TraceEvent } from "@workspace/contracts"
import { Badge } from "@workspace/ui/components/badge"

/**
 * Why the run did what it did, not just what it clicked.
 *
 * A trace of "clicked #4, clicked #7" is useless in an incident. Each line here
 * carries the step's English intent, the policy decision, which ranked strategy
 * resolved the target, and any recovery that was applied — the things somebody
 * reconstructing a run at 2am actually needs.
 *
 * The resolution rank is called out even on success. A step that used to resolve
 * by role and now resolves by its markup fallback still passed, and that is
 * precisely why it is worth seeing.
 */
export function TraceTimeline({
  trace,
}: {
  readonly trace: readonly TraceEvent[]
}) {
  return (
    <ol className="flex flex-col">
      {trace.map((event, index) => (
        <li
          key={index}
          className="flex gap-3 border-b py-2 text-sm last:border-0"
        >
          <TraceLine event={event} />
        </li>
      ))}
    </ol>
  )
}

function TraceLine({ event }: { readonly event: TraceEvent }) {
  return Match.value(event).pipe(
    Match.tag("StepStarted", (started) => (
      <>
        <Marker id={started.stepId} />
        <span>{started.intent}</span>
      </>
    )),

    Match.tag("TargetResolved", (resolved) => (
      <>
        <Marker id={resolved.stepId} />
        <span className="text-muted-foreground">
          resolved by {describeStrategy(resolved.resolution.strategy)}
          {resolved.resolution.rank > 0 ? (
            <Badge variant="secondary" className="ml-2">
              rank {resolved.resolution.rank} · drift
            </Badge>
          ) : null}
        </span>
      </>
    )),

    Match.tag("ActionPerformed", (performed) => (
      <>
        <Marker id={performed.stepId} />
        <span className="text-muted-foreground">
          {performed.action} · {performed.durationMs}ms
        </span>
      </>
    )),

    Match.tag("CheckpointPassed", (passed) => (
      <>
        <Marker id={passed.stepId} />
        <span className="text-muted-foreground">checkpoint passed</span>
      </>
    )),

    Match.tag("RecoveryApplied", (recovery) => (
      <>
        <Marker id={recovery.stepId} />
        <span>
          <Badge variant="outline">recovered</Badge>{" "}
          <span className="text-muted-foreground">
            {recovery.recovery} (attempt {recovery.attempt})
          </span>
        </span>
      </>
    )),

    Match.tag("PolicyDecision", (decision) => (
      <>
        <Marker id={decision.stepId} />
        <span className="text-muted-foreground">
          policy · {decision.decision}
          {decision.rule ? ` (${decision.rule})` : ""}
        </span>
      </>
    )),

    Match.tag("OutcomeDetected", (outcome) => (
      <>
        <Marker id={outcome.stepId} />
        <span>
          <Badge variant="secondary">{outcome.outcome}</Badge>
        </span>
      </>
    )),

    Match.tag("ControlHandedOver", (handover) => (
      <>
        <Marker id={handover.stepId} />
        <span>
          <Badge variant="outline">handed to a person</Badge>{" "}
          <span className="text-muted-foreground">{handover.reason}</span>
        </span>
      </>
    )),

    Match.tag("ControlReturned", (returned) => (
      <>
        <Marker id={returned.stepId} />
        <span>
          <Badge variant="outline">handed back</Badge>{" "}
          <span className="text-muted-foreground">
            {returned.by} · {returned.disposition} ·{" "}
            {returned.operatorActions} operator action(s)
          </span>
        </span>
      </>
    )),

    Match.tag("EvidenceCaptured", (captured) => (
      <>
        <Marker id={captured.stepId ?? ""} />
        <span className="text-muted-foreground">
          captured {captured.kind}
        </span>
      </>
    )),

    Match.exhaustive
  )
}

function Marker({ id }: { readonly id: string }) {
  return (
    <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">
      {id}
    </span>
  )
}

const describeStrategy = (
  strategy: { readonly _tag: string; readonly kind?: string }
): string =>
  strategy._tag === "fallback" && strategy.kind
    ? `${strategy._tag} (${strategy.kind})`
    : strategy._tag
