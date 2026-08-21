import {
  createPartFromFunctionResponse,
  GoogleGenAI,
  type Chat,
  type FunctionDeclaration,
  type Part,
} from "@google/genai"

import type {
  ModelClient,
  ModelMessage,
  ModelSession,
  ModelSessionConfig,
  ModelTurn,
} from "./model.js"

/**
 * Gemini, behind the model boundary.
 *
 * Intentionally thin: it translates our provider-neutral shapes into the SDK's
 * and back, and does nothing else. All the judgement — what tools exist, what
 * the prompt says, how a refusal is handled, what gets recorded — lives in the
 * loop, so swapping providers is an afternoon rather than a rewrite.
 *
 * Two SDK details worth knowing:
 *
 *  - Tools are declared with `parametersJsonSchema`, which takes plain JSON
 *    Schema, rather than `parameters`, which takes the SDK's own `Schema` type.
 *    The two are mutually exclusive.
 *  - Automatic function calling is disabled. We want the calls handed back so
 *    every one of them passes the policy chokepoint; letting the SDK invoke
 *    them would route around the guardrail entirely.
 */

/**
 * The most capable Gemini tier at time of writing. Discovery runs once per
 * capability, so capability matters more than cost here — replay never calls a
 * model at all. Override with GEMINI_MODEL; `gemini-3.7-flash` is the cheaper,
 * stable alternative.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.1-pro-preview"

export interface GeminiOptions {
  readonly apiKey?: string
  readonly model?: string
  readonly temperature?: number
  readonly maxAttempts?: number
}

/**
 * Transient upstream failures, which are routine when calling a hosted model:
 * 429 when rate limited, 503 when the model is busy, 5xx generally.
 *
 * These are worth retrying and a 400 is not — a malformed tool declaration will
 * be just as malformed in four seconds, and retrying it wastes a discovery run's
 * budget while hiding the real problem.
 */
const isTransient = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)

  /**
   * A *daily* quota is not transient, and retrying it is actively harmful: each
   * attempt consumes another request from the very quota that is exhausted, so a
   * backoff loop burns the rest of the day's budget to no purpose.
   *
   * The distinction has to be made on the quota *id*, not the metric name: a
   * per-minute throttle and a per-day cap are both reported under
   * `free_tier_requests`, and only `…PerDayPerProject…` is the fatal one. A
   * per-minute limit is exactly what backoff is for.
   */
  if (/PerDay/i.test(message)) return false

  return (
    /\b(429|500|502|503|504)\b/.test(message) ||
    /UNAVAILABLE|RESOURCE_EXHAUSTED/i.test(message)
  )
}

/** Google returns `"retryDelay": "25s"` on throttling; honour it when present. */
const retryDelayMs = (error: unknown): number | undefined => {
  const message = error instanceof Error ? error.message : String(error)
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message)
  return match?.[1] ? Math.ceil(Number(match[1]) * 1000) : undefined
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A discovery run is a long conversation; losing it to one busy-model response
 * means starting the whole thing again, so a few seconds of backoff is cheap
 * insurance. Bounded, because a model that is down for a minute should surface
 * as a failure rather than a hang.
 */
const withRetry = async <A>(
  attempt: () => Promise<A>,
  maxAttempts: number,
  onRetry: (attempt: number, error: unknown) => void
): Promise<A> => {
  let lastError: unknown

  for (let tries = 1; tries <= maxAttempts; tries++) {
    try {
      return await attempt()
    } catch (error) {
      lastError = error
      if (!isTransient(error) || tries === maxAttempts) throw error

      onRetry(tries, error)
      await delay(retryDelayMs(error) ?? Math.min(2 ** tries * 1_000, 15_000))
    }
  }

  throw lastError
}

export const makeGeminiClient = ({
  apiKey = process.env["GEMINI_API_KEY"] ?? process.env["GOOGLE_API_KEY"],
  model = process.env["GEMINI_MODEL"] ?? DEFAULT_GEMINI_MODEL,
  temperature = 0,
  maxAttempts = 5,
}: GeminiOptions = {}): ModelClient => {
  if (!apiKey) {
    throw new Error(
      "No Gemini API key. Set GEMINI_API_KEY (from https://aistudio.google.com/apikey) " +
        "before running discovery. Replay does not need one."
    )
  }

  const ai = new GoogleGenAI({ apiKey })

  return {
    id: model,

    startSession: async (config: ModelSessionConfig): Promise<ModelSession> => {
      const functionDeclarations: FunctionDeclaration[] = config.tools.map(
        (tool) => ({
          name: tool.name,
          description: tool.description,
          parametersJsonSchema: tool.parameters,
        })
      )

      const chat: Chat = ai.chats.create({
        model,
        config: {
          systemInstruction: config.system,
          tools: [{ functionDeclarations }],
          // Hand tool calls back to us; they must pass policy before they run.
          automaticFunctionCalling: { disable: true },
          // Discovery should be reproducible enough to debug.
          temperature,
        },
      })

      return {
        send: async (message: ModelMessage): Promise<ModelTurn> => {
          const parts: Part[] =
            message._tag === "text"
              ? [{ text: message.text }]
              : message.results.map((result) =>
                  createPartFromFunctionResponse(
                    result.id ?? result.name,
                    result.name,
                    // The SDK expects the payload under `output`.
                    { output: result.response }
                  )
                )

          const response = await withRetry(
            () => chat.sendMessage({ message: parts }),
            maxAttempts,
            (attempt, error) => {
              const reason =
                error instanceof Error ? error.message : String(error)
              console.warn(
                `  model unavailable (attempt ${attempt}/${maxAttempts}), retrying: ${reason.slice(0, 120)}`
              )
            }
          )

          return {
            text: response.text,
            calls: (response.functionCalls ?? []).map((call) => ({
              id: call.id,
              name: call.name ?? "",
              args: call.args ?? {},
            })),
          }
        },
      }
    },
  }
}
