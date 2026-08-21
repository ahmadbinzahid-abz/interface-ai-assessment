import { Data } from "effect"

/**
 * Adapter-level failures.
 *
 * These are deliberately *not* the same type as `ReplayError` in the contracts
 * package. A surface reports what it saw ("nothing matched", "three things
 * matched", "the actor does not hold control"); the replay engine decides what
 * that means for the run and which step it belongs to. Keeping the two apart is
 * what lets the discovery loop and the replay executor react differently to the
 * same adapter condition.
 */

export class TargetNotFound extends Data.TaggedError("TargetNotFound")<{
  readonly description: string
  readonly strategiesTried: number
}> {}

export class AmbiguousTarget extends Data.TaggedError("AmbiguousTarget")<{
  readonly description: string
  readonly matchCount: number
  /** Which strategy produced the ambiguity, so the fix is obvious. */
  readonly atRank: number
}> {}

export type TargetResolutionError = TargetNotFound | AmbiguousTarget

/** The actor asked to do something while someone else held the session. */
export class ControlDenied extends Data.TaggedError("ControlDenied")<{
  readonly actor: string
  readonly holder: string
}> {}

export class NavigationFailed extends Data.TaggedError("NavigationFailed")<{
  readonly url: string
  readonly detail: string
}> {}

export class InteractionFailed extends Data.TaggedError("InteractionFailed")<{
  readonly command: string
  readonly detail: string
}> {}

/** The browser or adapter itself is gone. Nothing to retry against. */
export class SurfaceUnavailable extends Data.TaggedError("SurfaceUnavailable")<{
  readonly detail: string
}> {}

export type SurfaceError =
  | ControlDenied
  | NavigationFailed
  | InteractionFailed
  | SurfaceUnavailable
