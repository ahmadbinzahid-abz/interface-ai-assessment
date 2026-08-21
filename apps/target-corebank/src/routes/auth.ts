import type { Hono } from "hono"
import { getCookie, setCookie } from "hono/cookie"

import { credentials } from "../config.js"
import { tenantPath, type AppEnv } from "../env.js"
import { createSession, SESSION_COOKIE, expireSession } from "../session.js"
import { deskUrl, loginPage } from "../views/pages.js"

export const registerAuthRoutes = (app: Hono<AppEnv>): void => {
  app.get(tenantPath("/login"), (c) => c.html(loginPage(c.get("tenant"))))

  app.post(tenantPath("/login"), async (c) => {
    const tenant = c.get("tenant")
    const form = await c.req.formData()
    const username = String(form.get("f1_ctl01") ?? "")
    const password = String(form.get("f1_ctl02") ?? "")

    if (
      username !== credentials.username ||
      password !== credentials.password
    ) {
      return c.html(loginPage(tenant, "Invalid operator ID or password."), 401)
    }

    const session = createSession(tenant.id, username)
    setCookie(c, SESSION_COOKIE, session.id, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    })

    return c.redirect(deskUrl(tenant), 303)
  })

  app.get(tenantPath("/logout"), (c) => {
    expireSession(getCookie(c, SESSION_COOKIE))
    return c.redirect(`/${c.get("tenant").id}/login`, 303)
  })
}
