/**
 * The stand-in runs on 4100 so it never collides with the operator console (3000)
 * or the orchestrator API.
 */
export const config = {
  port: Number(process.env["PORT"] ?? 4100),

  /**
   * Deliberately short. Session expiry is one of the runtime conditions replay has
   * to survive, so it needs to be reachable in a test rather than theoretical.
   */
  sessionTtlMs: Number(process.env["SESSION_TTL_MS"] ?? 15 * 60 * 1000),

  /** How long the injected `slow` fault stalls a request. */
  slowResponseMs: Number(process.env["SLOW_RESPONSE_MS"] ?? 3_000),
} as const

/**
 * The only credentials this app accepts. Fake, and the whole point: no real
 * institution credentials ever enter this project.
 */
export const credentials = {
  username: "teller01",
  password: "demo-pass",
} as const
