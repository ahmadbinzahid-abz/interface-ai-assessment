import type { OperatorInput } from "@workspace/contracts"
import type { Effect } from "effect"

import type { SurfaceError } from "./errors.js"
import type { Actor } from "./types.js"

/**
 * The co-browsing seam.
 *
 * Live takeover is the one place where the abstraction has to expose something
 * *un*symbolic: a human moves a mouse, and there is no role-and-name description
 * of a mouse move. So this file is deliberately separate from `types.ts` — the
 * portable surface contract stays free of pixels, and a surface that cannot be
 * co-browsed simply does not implement this.
 *
 * The two halves mirror each other. `startScreencast` carries pixels out;
 * `dispatch` carries input in. Both go through the same control lease as
 * everything else, which is what makes "the human is driving now" a fact the
 * system enforces rather than a state it displays.
 */

/** One frame of the live page, ready to put on a wire. */
export interface ScreencastFrame {
  /** base64 JPEG. */
  readonly data: string
  /** The size these pixels are in — the space input coordinates are expressed in. */
  readonly width: number
  readonly height: number
  readonly at: string
}

export interface Screencast {
  readonly stop: () => Effect.Effect<void>
}

export interface ScreencastOptions {
  /** JPEG quality, 0–100. Low by default: this is a control channel, not a video. */
  readonly quality?: number
  readonly maxWidth?: number
  readonly maxHeight?: number
  /** Frames per second cap. CDP delivers on paint, so this throttles. */
  readonly everyNthFrame?: number
}

/**
 * What is under a point, read back from the accessibility tree.
 *
 * This is what turns a captured coordinate into something that could become an
 * artifact step. Without it an operator action log is a list of pixel positions,
 * which is faithful, unreviewable, and impossible to promote.
 */
export interface PointDescription {
  readonly role?: string
  readonly name?: string
  readonly frame: readonly string[]
  /** The control's own value, for a field the operator typed into. */
  readonly value?: string
}

export interface TakeoverSurface {
  /**
   * Send raw input to the live page.
   *
   * Lease-checked exactly like `act`. An operator whose claim has been revoked —
   * because the run took control back, or because a second console claimed —
   * has their input refused, not queued.
   */
  readonly dispatch: (
    actor: Actor,
    event: OperatorInput
  ) => Effect.Effect<void, SurfaceError>

  readonly startScreencast: (
    onFrame: (frame: ScreencastFrame) => void,
    options?: ScreencastOptions
  ) => Effect.Effect<Screencast, SurfaceError>

  readonly describeAt: (
    x: number,
    y: number
  ) => Effect.Effect<PointDescription, SurfaceError>
}

/** Not every surface can be co-browsed; a desktop adapter would answer no here. */
export const supportsTakeover = (
  surface: object
): surface is TakeoverSurface =>
  typeof (surface as TakeoverSurface).dispatch === "function" &&
  typeof (surface as TakeoverSurface).startScreencast === "function"
