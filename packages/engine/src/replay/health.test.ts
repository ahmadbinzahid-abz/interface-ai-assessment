import type { ReplayResult, ReplaySummary } from "@workspace/contracts"
import { describe, expect, it } from "vitest"

import {
  accumulateHealth,
  BASE_TENANT_KEY,
  driftingSteps,
} from "./health.js"

/**
 * The drift alarm's arithmetic, tested directly.
 *
 * A running mean over a growing series is easy to get subtly wrong and hard to
 * notice: the number stays plausible while being off. And the number is the
 * whole point — it is what tells an operator that a tenant's UI has moved before
 * anything actually fails.
 */

const summary: ReplaySummary = {
  runId: "r",
  capabilityId: "cap",
  capabilityVersion: "1.0.0",
  tenant: null,
  startedAt: "2026-08-24T00:00:00.000Z",
  durationMs: 1,
  stepsAttempted: 1,
}

/** A run in which the named steps needed a lower-ranked strategy. */
const run = (
  drifted: readonly string[],
  clean: readonly string[] = []
): ReplayResult => ({
  _tag: "Succeeded",
  summary,
  outputs: {},
  trace: [
    ...drifted.map((stepId) => ({
      _tag: "TargetResolved" as const,
      stepId,
      resolution: {
        strategy: { _tag: "fallback" as const, index: 0, kind: "css" as const },
        rank: 2,
        matchCount: 1,
      },
    })),
    ...clean.map((stepId) => ({
      _tag: "TargetResolved" as const,
      stepId,
      resolution: {
        strategy: { _tag: "roleAndName" as const },
        rank: 0,
        matchCount: 1,
      },
    })),
  ],
})

const failed = (): ReplayResult => ({
  _tag: "Failed",
  summary,
  error: { _tag: "StepTimeout", stepId: "s1", waitedMs: 10 },
  trace: [],
})

describe("accumulating replay telemetry", () => {
  it("records a first run as one replay at full rate", () => {
    const health = accumulateHealth({
      previous: undefined,
      result: run(["s5"], ["s6"]),
      tenant: "riverbend",
    })

    expect(health.replays).toBe(1)
    expect(health.successes).toBe(1)
    expect(health.fallbackHitRate["s5"]).toBe(1)
    expect(health.fallbackHitRate["s6"]).toBe(0)
  })

  it("keeps a running mean rather than the latest value", () => {
    let health = accumulateHealth({
      previous: undefined,
      result: run(["s5"]),
      tenant: null,
    })
    health = accumulateHealth({
      previous: health,
      result: run([], ["s5"]),
      tenant: null,
    })

    // One drifted, one did not. A "latest value" implementation would say 0 and
    // an operator would stop looking at a step that fails half the time.
    expect(health.fallbackHitRate["s5"]).toBe(0.5)
    expect(health.replays).toBe(2)
  })

  it("counts a failed replay without counting it as a success", () => {
    const health = accumulateHealth({
      previous: undefined,
      result: failed(),
      tenant: null,
    })

    expect(health.replays).toBe(1)
    expect(health.successes).toBe(0)
  })

  it("keeps each institution's drift separate", () => {
    let health = accumulateHealth({
      previous: undefined,
      result: run(["s5"]),
      tenant: "riverbend",
    })
    health = accumulateHealth({
      previous: health,
      result: run([], ["s5"]),
      tenant: "firstcity",
    })

    /**
     * The reason the split exists. In aggregate this capability drifts on half
     * its runs, which reads as "mildly flaky everywhere". Split, it says
     * Riverbend has moved and First City has not — which is a specific overlay
     * entry rather than a shrug.
     */
    expect(health.fallbackHitRate["s5"]).toBe(0.5)
    expect(health.byTenant["riverbend"]?.fallbackHitRate["s5"]).toBe(1)
    expect(health.byTenant["firstcity"]?.fallbackHitRate["s5"]).toBe(0)
  })

  it("files a run with no overlay under the base key", () => {
    const health = accumulateHealth({
      previous: undefined,
      result: run(["s5"]),
      tenant: null,
    })

    expect(health.byTenant[BASE_TENANT_KEY]?.replays).toBe(1)
  })

  it("treats a step that drifted on any attempt as drifted", () => {
    // A step retried after a recovery resolves more than once. The pessimistic
    // reading is the useful one: it needed a fallback, so it drifted.
    const health = accumulateHealth({
      previous: undefined,
      result: run(["s5"], ["s5"]),
      tenant: null,
    })

    expect(health.fallbackHitRate["s5"]).toBe(1)
  })
})

describe("proposing overlay work", () => {
  it("names the steps a tenant needs an overlay entry for", () => {
    let health = accumulateHealth({
      previous: undefined,
      result: run(["s5", "s6"]),
      tenant: "riverbend",
    })
    health = accumulateHealth({
      previous: health,
      result: run(["s5"], ["s6"]),
      tenant: "riverbend",
    })
    health = accumulateHealth({
      previous: health,
      result: run(["s5"], ["s6"]),
      tenant: "riverbend",
    })

    // s5 drifted on all three runs, s6 on one. Below the bar is deliberately
    // quiet: an alarm that fires on a third of runs teaches people to ignore it.
    expect(driftingSteps(health, "riverbend")).toEqual(["s5"])
  })

  it("says nothing about a tenant that has never drifted", () => {
    const health = accumulateHealth({
      previous: undefined,
      result: run([], ["s5"]),
      tenant: "firstcity",
    })

    expect(driftingSteps(health, "firstcity")).toEqual([])
    // And nothing at all about a tenant it has never seen.
    expect(driftingSteps(health, "someone-else")).toEqual([])
  })
})
