import type {
  Action,
  Condition,
  RiskClass,
  Sensitivity,
  ValueFormat,
} from "@workspace/contracts"

export interface DiscoveryParameter {
  readonly name: string
  /** The concrete value used during discovery. Never persisted into the artifact. */
  readonly value: string
  readonly description: string
  readonly sensitivity?: Sensitivity
}

/**
 * A step as it was actually performed, before compilation.
 *
 * Kept separate from the artifact's `Step` because discovery knows things the
 * artifact should not carry — how long it took in the browser, which strategy
 * rank resolved it — and because the compiler still has work to do afterwards
 * (parameterising values, ordering outputs, attaching the success condition).
 */
export interface RecordedStep {
  readonly id: string
  readonly intent: string
  readonly action: Action
  readonly riskClass: RiskClass
  readonly checkpoint?: Condition
  readonly observedMs: number
  /** Which ranked strategy found the target when it was recorded. */
  readonly resolvedAtRank?: number
  /**
   * The model took this step to *learn* the application rather than to advance
   * the goal — probing an invalid id to find the not-found screen. Kept in
   * evidence, excluded from the compiled flow.
   */
  readonly exploratory?: boolean
}

export interface RecordedOutput {
  readonly name: string
  readonly format: ValueFormat
  readonly description: string
  /** What was actually read during discovery, for evidence only. */
  readonly sampleValue: string
}

export interface RecordedOutcome {
  readonly tag: string
  readonly description: string
  readonly whenText: string
}

export type DiscoveryResult =
  | {
      readonly _tag: "Completed"
      readonly summary: string
      readonly successText: string
    }
  /** The model asked for a human. A legitimate ending, not a failure. */
  | { readonly _tag: "Escalated"; readonly reason: string }
  | { readonly _tag: "GaveUp"; readonly reason: string }
  /** A stopping condition fired: too many steps, or too long. */
  | { readonly _tag: "Exhausted"; readonly reason: string }

export interface DiscoveryRun {
  readonly runId: string
  readonly result: DiscoveryResult
  readonly steps: readonly RecordedStep[]
  readonly outputs: readonly RecordedOutput[]
  readonly outcomes: readonly RecordedOutcome[]
  readonly modelId: string
  readonly turns: number
  readonly durationMs: number
}
