import type { Hono } from "hono"

import { resetMembers } from "../data/members.js"
import type { AppEnv } from "../env.js"
import {
  armFault,
  isFaultMode,
  listArmedFaults,
  resetFaults,
} from "../faults.js"
import { resetSessions } from "../session.js"

/**
 * Out-of-band test control.
 *
 * This is not part of the application being automated — nothing the agent or the
 * replay engine does ever touches it. It exists so a test can arm a runtime
 * condition *without changing the URLs the capability navigates*, which keeps a
 * fault-injection replay honest: same flow, same steps, different runtime.
 *
 * A real deployment would not expose this. It is namespaced under `__control` and
 * excluded from the automation allowlist.
 */
interface FaultRequest {
  mode?: string
  times?: number
}

export const registerControlRoutes = (app: Hono<AppEnv>): void => {
  app.post("/__control/fault", async (c) => {
    const body = await c.req
      .json<FaultRequest>()
      .catch((): FaultRequest => ({}))
    const mode = body.mode ?? ""

    if (!isFaultMode(mode)) {
      return c.json(
        { error: `Unknown fault mode: ${mode || "(missing)"}` },
        400
      )
    }

    armFault(mode, body.times ?? 1)
    return c.json({ armed: listArmedFaults() })
  })

  app.post("/__control/reset", (c) => {
    resetFaults()
    resetSessions()
    resetMembers()
    return c.json({ ok: true })
  })

  app.get("/__control/state", (c) => c.json({ armed: listArmedFaults() }))
}
