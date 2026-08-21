import { randomUUID } from "node:crypto"

import { config } from "./config.js"

export interface Session {
  readonly id: string
  readonly tenantId: string
  readonly username: string
  expiresAt: number
}

/**
 * In-memory sessions. A real core banking app would use a server-side session
 * table; the only property that matters here is that a session can *expire
 * mid-flow*, which is one of the runtime conditions replay must recover from.
 */
const sessions = new Map<string, Session>()

export const SESSION_COOKIE = "CBSESSIONID"

export const createSession = (tenantId: string, username: string): Session => {
  const session: Session = {
    id: randomUUID(),
    tenantId,
    username,
    expiresAt: Date.now() + config.sessionTtlMs,
  }
  sessions.set(session.id, session)
  return session
}

export const getSession = (id: string | undefined): Session | undefined => {
  if (!id) return undefined

  const session = sessions.get(id)
  if (!session) return undefined

  if (session.expiresAt <= Date.now()) {
    sessions.delete(id)
    return undefined
  }

  return session
}

/** Used by the `session-expired` fault to kill a live session on demand. */
export const expireSession = (id: string | undefined): void => {
  if (id) sessions.delete(id)
}

export const resetSessions = (): void => {
  sessions.clear()
}
