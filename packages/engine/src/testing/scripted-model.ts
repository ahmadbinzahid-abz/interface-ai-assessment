import type {
  ModelClient,
  ModelMessage,
  ModelSession,
  ModelTurn,
  ModelToolCall,
} from "../model.js"

/**
 * A model that does exactly what you tell it to.
 *
 * The discovery loop is where policy enforcement, step recording, descriptor
 * synthesis and the stale-reference guard all live — the parts most worth
 * testing, and the parts a real model would make untestable by being different
 * every run. Scripting the model turns the whole pipeline into a deterministic
 * unit under test, and leaves the real client as a thin translation layer with
 * nothing clever in it.
 *
 * A script step may be a fixed list of calls, or a function of the screen the
 * loop just showed — which is how a test drives a genuinely reactive run
 * (find the control numbered like *this*, then click it) rather than a replay of
 * hard-coded numbers.
 */

export type ScriptStep =
  | readonly ModelToolCall[]
  | ((context: ScriptContext) => readonly ModelToolCall[])

export interface ScriptContext {
  /** The rendered screen from the most recent tool result or opening message. */
  readonly screen: string
  readonly turn: number
  /** Everything the loop has sent back, for assertions inside a script. */
  readonly lastResults: readonly Record<string, unknown>[]
}

export interface ScriptedModelOptions {
  readonly id?: string
  readonly script: readonly ScriptStep[]
}

/** Pull the rendered screen back out of whatever the loop last sent. */
const screenFrom = (message: ModelMessage): string | undefined => {
  if (message._tag === "text") return message.text

  for (const result of [...message.results].reverse()) {
    const screen = result.response["screen"]
    if (typeof screen === "string") return screen
  }

  return undefined
}

export const makeScriptedModel = ({
  id = "scripted-model",
  script,
}: ScriptedModelOptions): ModelClient => ({
  id,

  startSession: async (): Promise<ModelSession> => {
    let turn = 0
    let screen = ""

    return {
      send: async (message: ModelMessage): Promise<ModelTurn> => {
        const seen = screenFrom(message)
        if (seen !== undefined) screen = seen

        const lastResults =
          message._tag === "toolResults"
            ? message.results.map((result) => result.response)
            : []

        const step = script[turn]
        turn += 1

        // Running off the end of the script means the loop asked for more turns
        // than the test expected. Giving up loudly beats hanging.
        if (!step) {
          return {
            calls: [
              {
                name: "give_up",
                args: { reason: `The script ran out after ${turn - 1} turns.` },
              },
            ],
          }
        }

        const calls =
          typeof step === "function"
            ? step({ screen, turn, lastResults })
            : step

        return { calls }
      },
    }
  },
})

/** Finds the `#n` of the first control whose rendered line matches. */
export const refMatching = (screen: string, pattern: RegExp): number => {
  for (const line of screen.split("\n")) {
    if (!pattern.test(line)) continue
    const match = /#(\d+)/.exec(line)
    if (match?.[1]) return Number(match[1])
  }

  throw new Error(`No control matching ${pattern} on screen:\n${screen}`)
}
