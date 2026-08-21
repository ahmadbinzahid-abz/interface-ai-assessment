import type { Server } from "node:http"

import { serve } from "@hono/node-server"

import { createApp } from "./app.js"
import { resetMembers } from "./data/members.js"
import { resetFaults } from "./faults.js"
import { resetSessions } from "./session.js"

export interface CoreBankTestServer {
  readonly baseUrl: string
  /** Restore fixture data, sessions, and armed faults to their initial state. */
  readonly reset: () => void
  readonly stop: () => Promise<void>
}

/**
 * Boots the stand-in on an ephemeral port for tests in other packages.
 *
 * Lives here rather than in each consumer so the fixture owns how it starts —
 * a test that needs a legacy app to automate should not also have to know which
 * HTTP server it runs on.
 */
export const startCoreBank = async (): Promise<CoreBankTestServer> => {
  const server = serve({ fetch: createApp().fetch, port: 0 }) as Server

  const address = server.address()
  const port =
    typeof address === "object" && address !== null ? address.port : 0

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    reset: () => {
      resetFaults()
      resetSessions()
      resetMembers()
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
