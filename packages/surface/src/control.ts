import type { Actor } from "./types.js"

/**
 * Who currently holds the session.
 *
 * Exactly one party drives at a time, and the adapter checks this before every
 * mutating command. That is what makes the human handoff a real transfer rather
 * than a convention: while an operator holds the lease, an automation command is
 * *refused*, not merely discouraged, so a paused run cannot race the person who
 * took over from it.
 *
 * Phase 5 builds the full state machine (pause requested → awaiting operator →
 * operator driving → handback) on top of this. The lease is the part the surface
 * needs, and it exists now so the enforcement point is real from the start
 * rather than retrofitted.
 */
export type ControlHolder =
  | { readonly _tag: "none" }
  | { readonly _tag: "automation"; readonly runId: string }
  | { readonly _tag: "operator"; readonly operatorId: string }

export const describeHolder = (holder: ControlHolder): string =>
  holder._tag === "none"
    ? "nobody"
    : holder._tag === "automation"
      ? `automation:${holder.runId}`
      : `operator:${holder.operatorId}`

export const describeActor = (actor: Actor): string =>
  actor._tag === "automation"
    ? `automation:${actor.runId}`
    : `operator:${actor.operatorId}`

export class ControlLease {
  #holder: ControlHolder = { _tag: "none" }

  current(): ControlHolder {
    return this.#holder
  }

  grantTo(holder: Exclude<ControlHolder, { _tag: "none" }>): void {
    this.#holder = holder
  }

  release(): void {
    this.#holder = { _tag: "none" }
  }

  /**
   * Identity, not merely role: one automation run may not act on a session
   * leased to a different run.
   */
  permits(actor: Actor): boolean {
    const holder = this.#holder

    if (holder._tag === "automation" && actor._tag === "automation") {
      return holder.runId === actor.runId
    }

    if (holder._tag === "operator" && actor._tag === "operator") {
      return holder.operatorId === actor.operatorId
    }

    return false
  }
}
