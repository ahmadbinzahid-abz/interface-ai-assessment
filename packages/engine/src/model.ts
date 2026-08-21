/**
 * The model boundary.
 *
 * The discovery loop talks to this interface, never to a vendor SDK. That keeps
 * the provider swappable, but the reason it earns its place is testing: the loop,
 * the recorder, the policy chokepoint and the artifact compiler are the parts
 * with real logic in them, and none of them should need a paid API call and a
 * network round trip to be exercised. A scripted client makes the whole discovery
 * pipeline testable deterministically; the real client is then a thin adapter
 * whose only job is translating shapes.
 */

/** A function the model may call. `parameters` is plain JSON Schema. */
export interface ToolDeclaration {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

export interface ModelToolCall {
  /** Correlation id, where the provider supplies one. */
  readonly id?: string
  readonly name: string
  readonly args: Record<string, unknown>
}

export interface ModelToolResult {
  readonly id?: string
  readonly name: string
  readonly response: Record<string, unknown>
}

export interface ModelTurn {
  readonly text?: string
  readonly calls: readonly ModelToolCall[]
}

export type ModelMessage =
  | { readonly _tag: "text"; readonly text: string }
  | {
      readonly _tag: "toolResults"
      readonly results: readonly ModelToolResult[]
    }

export interface ModelSession {
  readonly send: (message: ModelMessage) => Promise<ModelTurn>
}

export interface ModelSessionConfig {
  readonly system: string
  readonly tools: readonly ToolDeclaration[]
}

export interface ModelClient {
  /** Recorded in artifact provenance, so a capability names the model that found it. */
  readonly id: string
  readonly startSession: (config: ModelSessionConfig) => Promise<ModelSession>
}
