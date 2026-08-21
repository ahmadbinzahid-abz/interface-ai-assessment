import type {
  NodeBounds,
  Observation,
  Resolution,
  TargetDescriptor,
} from "@workspace/contracts"
import type { Effect } from "effect"

import type { SurfaceError, TargetResolutionError } from "./errors.js"

/**
 * The seam between "how we perceive and act on a surface" and "the recorded flow".
 *
 * Nothing in this file mentions a browser, a selector, or the DOM — that is the
 * whole point. A recorded capability is expressed in terms of observations,
 * descriptors and commands; a *surface adapter* is whatever knows how to produce
 * an observation and carry out a command against one particular kind of thing.
 * Adding a desktop surface means writing an adapter, not touching the schema, the
 * replay engine, or a single artifact.
 */

/** Who is driving. Every mutating command has to say. */
export type Actor =
  | { readonly _tag: "automation"; readonly runId: string }
  | { readonly _tag: "operator"; readonly operatorId: string }

/**
 * An adapter-specific pointer to a resolved control.
 *
 * Handles are deliberately opaque and short-lived: they are produced by a
 * resolution against one observation and are meaningless afterwards. Nothing
 * durable — least of all an artifact — is ever allowed to hold one, which is
 * what stops "stable targeting" quietly decaying into "recorded selector".
 */
export type TargetHandle =
  /** Resolved from the accessibility tree. The portable case. */
  | {
      readonly _tag: "node"
      readonly frame: readonly string[]
      readonly nodeId: string
      readonly platformHandle: number
    }
  /** Resolved by a markup query. Web-only, and a fallback by construction. */
  | {
      readonly _tag: "query"
      readonly frame: readonly string[]
      readonly kind: "css" | "xpath"
      readonly expression: string
    }
  /** Resolved by position. The last resort, and the one a desktop surface shares. */
  | { readonly _tag: "point"; readonly x: number; readonly y: number }

/** What the adapter can tell us about a resolved control, for recording. */
export interface ElementDetail {
  readonly attributes: Record<string, string>
  readonly bounds?: NodeBounds
  readonly viewport?: { readonly width: number; readonly height: number }
}

export interface ResolvedTarget {
  readonly handle: TargetHandle
  /** Which ranked strategy won. Recorded on every step — this is the drift signal. */
  readonly resolution: Resolution
}

/**
 * A command is an action with everything already decided: the target resolved to
 * a handle, and every `ValueRef` already dereferenced to a concrete string.
 *
 * Keeping parameter and secret resolution *out* of the adapter matters: it means
 * an adapter can never be the thing that leaks a credential, and it means the
 * engine owns the one place where a `{$secret}` becomes a real value.
 */
export type SurfaceCommand =
  | { readonly _tag: "navigate"; readonly url: string }
  | { readonly _tag: "click"; readonly handle: TargetHandle }
  | {
      readonly _tag: "type"
      readonly handle: TargetHandle
      readonly text: string
      readonly clearFirst: boolean
    }
  | {
      readonly _tag: "select"
      readonly handle: TargetHandle
      readonly value: string
    }
  | { readonly _tag: "press"; readonly key: string }

export interface Surface {
  /**
   * Perceive the current state. Free of the control lease on purpose: we keep
   * observing while a human is driving, because that is how the handoff gets
   * recorded.
   */
  readonly observe: () => Effect.Effect<Observation, SurfaceError>

  /** Rank the descriptor's strategies against the live surface. */
  readonly resolve: (
    descriptor: TargetDescriptor
  ) => Effect.Effect<ResolvedTarget, TargetResolutionError | SurfaceError>

  /**
   * Do something. Requires the actor to hold control of the session — this is
   * the chokepoint that makes the automation/operator handoff real rather than
   * advisory.
   */
  readonly act: (
    actor: Actor,
    command: SurfaceCommand
  ) => Effect.Effect<void, SurfaceError>

  /** Read a resolved control's text. Reading does not require control. */
  readonly read: (handle: TargetHandle) => Effect.Effect<string, SurfaceError>

  /**
   * Platform details about a resolved control, used when *recording* a step to
   * build the ranked fallbacks — the legacy control name, an id, a centre point.
   *
   * Deliberately separate from `observe`: this is per-control and only needed at
   * record time, so a discovery run pays for it once per acted-on control rather
   * than for every node on every screen. A desktop adapter would return its own
   * equivalents (automation id, control type) through the same shape.
   */
  readonly describe: (
    handle: TargetHandle
  ) => Effect.Effect<ElementDetail, SurfaceError>

  /** Raw image bytes. Redaction happens at the evidence boundary, not here. */
  readonly screenshot: () => Effect.Effect<Uint8Array, SurfaceError>

  readonly close: () => Effect.Effect<void>
}
