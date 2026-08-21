/**
 * Fault injection.
 *
 * Faults are *armed out of band* through `/__control/fault` rather than passed as
 * a query parameter on the page being automated. That distinction matters: a
 * recorded capability must contain the same URLs in a fault test as in a happy
 * run, otherwise the test is exercising a different flow than production would.
 *
 * Each armed fault fires a fixed number of times and then clears itself, so a
 * replay can hit the condition, recover, and go on to succeed.
 */

export const faultModes = [
  /** The next protected request finds its session gone. Recoverable: re-auth. */
  "session-expired",
  /** The next page render is preceded by a maintenance notice. Recoverable: dismiss. */
  "interstitial",
  /** The next search stalls. Recoverable: wait. */
  "slow",
  /** The next request returns 500. A hard failure the caller must see. */
  "server-error",
  /** The next sub-account submission is rejected by the server. A business outcome. */
  "validation",
] as const

export type FaultMode = (typeof faultModes)[number]

export const isFaultMode = (value: string): value is FaultMode =>
  (faultModes as readonly string[]).includes(value)

const armed = new Map<FaultMode, number>()

export const armFault = (mode: FaultMode, times = 1): void => {
  armed.set(mode, times)
}

/** Returns true at most `times` times per arming, then disarms. */
export const consumeFault = (mode: FaultMode): boolean => {
  const remaining = armed.get(mode)
  if (!remaining || remaining <= 0) return false

  if (remaining === 1) armed.delete(mode)
  else armed.set(mode, remaining - 1)

  return true
}

export const listArmedFaults = (): Record<string, number> =>
  Object.fromEntries(armed.entries())

export const resetFaults = (): void => {
  armed.clear()
}
