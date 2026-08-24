import { Badge } from "@workspace/ui/components/badge"
import type { RunSummary } from "@workspace/contracts"

/**
 * How a run's outcome is shown, in one place.
 *
 * The colour choice is the point, and it is the same argument the executor
 * makes: **a business outcome is not a failure.** "No such member" is the
 * application answering correctly, and painting it red would teach every
 * operator to treat a working system as a broken one — which is exactly the
 * mistake the result union exists to prevent. It gets its own neutral treatment,
 * distinct from both success and failure.
 */

type Outcome = RunSummary["outcome"]

const TONE: Record<
  Outcome,
  { variant: "default" | "secondary" | "destructive" | "outline"; label: string }
> = {
  Succeeded: { variant: "default", label: "Succeeded" },
  // Answered, and the answer was a declared non-success. Not an incident.
  BusinessOutcome: { variant: "secondary", label: "Business outcome" },
  Escalated: { variant: "outline", label: "Escalated" },
  Failed: { variant: "destructive", label: "Failed" },
  Running: { variant: "outline", label: "Running" },
  Recorded: { variant: "secondary", label: "Recorded" },
}

export function OutcomeBadge({ outcome }: { readonly outcome: Outcome }) {
  const tone = TONE[outcome]
  return <Badge variant={tone.variant}>{tone.label}</Badge>
}

const STATUS_TONE: Record<
  "draft" | "candidate" | "approved" | "deprecated",
  "default" | "secondary" | "destructive" | "outline"
> = {
  draft: "outline",
  candidate: "secondary",
  approved: "default",
  deprecated: "destructive",
}

/**
 * A capability's lifecycle status.
 *
 * `draft` is the default a compiler emits, and it means *a model wrote this and
 * nobody has read it*. Showing it plainly matters because the policy engine
 * treats an unapproved artifact differently: a risky step from a draft needs a
 * human, and an operator should be able to see why before they are asked.
 */
export function CapabilityStatusBadge({
  status,
}: {
  readonly status: "draft" | "candidate" | "approved" | "deprecated"
}) {
  return <Badge variant={STATUS_TONE[status]}>{status}</Badge>
}

export function RiskBadge({
  risk,
}: {
  readonly risk: "safe" | "risky" | "irreversible"
}) {
  return (
    <Badge
      variant={
        risk === "irreversible"
          ? "destructive"
          : risk === "risky"
            ? "secondary"
            : "outline"
      }
    >
      {risk}
    </Badge>
  )
}
