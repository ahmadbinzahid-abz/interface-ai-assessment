import {
  Health,
  TenantHealth,
  type ReplayResult,
} from "@workspace/contracts"

/**
 * Replay telemetry, accumulated on the artifact.
 *
 * The number that matters is `fallbackHitRate`: a step that used to resolve by
 * role and now resolves by its markup fallback still *passes*, and that is
 * exactly why it deserves attention. It is the earliest signal an install's UI
 * has moved, and it arrives long before the capability actually breaks. Waiting
 * for a failure means finding out during someone's workday.
 *
 * Kept per tenant as well as in aggregate, because aggregate drift stops meaning
 * anything once one capability serves many institutions. Three percent across
 * forty installs is either forty installs slightly degraded or one install that
 * has moved — and only the second is something a person should act on.
 *
 * Pure on purpose: this is a running mean over a growing series, which is the
 * kind of arithmetic that is easy to get subtly wrong and easy to test directly.
 */

/** Where runs with no overlay applied are counted. */
export const BASE_TENANT_KEY = "__base"

/** The share of *this* run's resolutions that needed a lower-ranked strategy. */
const fallbacksIn = (
  result: ReplayResult
): ReadonlyMap<string, boolean> => {
  const hits = new Map<string, boolean>()

  for (const event of result.trace) {
    if (event._tag !== "TargetResolved") continue
    // A step retried after a recovery resolves more than once. The pessimistic
    // reading is the useful one: if it ever needed a fallback, it drifted.
    hits.set(event.stepId, (hits.get(event.stepId) ?? false) || event.resolution.rank > 0)
  }

  return hits
}

const accumulateRates = (
  previous: Readonly<Record<string, number>>,
  result: ReplayResult,
  replays: number
): Record<string, number> => {
  const rates: Record<string, number> = { ...previous }

  for (const [stepId, drifted] of fallbacksIn(result)) {
    const before = rates[stepId] ?? 0
    // Running mean: the previous mean carried `replays - 1` observations.
    rates[stepId] = (before * (replays - 1) + (drifted ? 1 : 0)) / replays
  }

  return rates
}

export interface HealthUpdate {
  readonly previous: Health | undefined
  readonly result: ReplayResult
  /** Null for a run against the base artifact, with no overlay applied. */
  readonly tenant: string | null
  readonly at?: string
}

export const accumulateHealth = ({
  previous,
  result,
  tenant,
  at = new Date().toISOString(),
}: HealthUpdate): Health => {
  const succeeded = result._tag === "Succeeded"

  const replays = (previous?.replays ?? 0) + 1
  const successes = (previous?.successes ?? 0) + (succeeded ? 1 : 0)

  const key = tenant ?? BASE_TENANT_KEY
  const before = previous?.byTenant?.[key]
  const tenantReplays = (before?.replays ?? 0) + 1

  return new Health({
    replays,
    successes,
    lastVerifiedAt: at,
    fallbackHitRate: accumulateRates(
      previous?.fallbackHitRate ?? {},
      result,
      replays
    ),
    byTenant: {
      ...(previous?.byTenant ?? {}),
      [key]: new TenantHealth({
        replays: tenantReplays,
        successes: (before?.successes ?? 0) + (succeeded ? 1 : 0),
        lastVerifiedAt: at,
        fallbackHitRate: accumulateRates(
          before?.fallbackHitRate ?? {},
          result,
          tenantReplays
        ),
      }),
    },
  })
}

/**
 * Steps whose drift on one tenant is worth acting on.
 *
 * The proposal this feeds is concrete: a step that resolves by fallback on at
 * least half its runs *for one institution* — and not for the others — is a step
 * that institution needs an overlay entry for. That is a reviewable pull request
 * rather than an alert nobody knows what to do with.
 *
 * The bar is deliberately not "ever". A step that drifted once is noise, and an
 * alarm that fires on noise is one people learn to close.
 */
export const driftingSteps = (
  health: Health | undefined,
  tenant: string,
  threshold = 0.5
): readonly string[] => {
  const rates = health?.byTenant?.[tenant]?.fallbackHitRate ?? {}

  return Object.entries(rates)
    .filter(([, rate]) => rate >= threshold)
    .map(([stepId]) => stepId)
    .sort()
}
