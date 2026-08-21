import { Hono, type MiddlewareHandler } from "hono"
import { getCookie } from "hono/cookie"

import { tenantPath, type AppEnv } from "./env.js"
import { consumeFault } from "./faults.js"
import { registerAuthRoutes } from "./routes/auth.js"
import { registerControlRoutes } from "./routes/control.js"
import { registerDeskRoutes } from "./routes/desk.js"
import { defaultTenantId, getTenant } from "./tenants.js"
import { expireSession, getSession, SESSION_COOKIE } from "./session.js"
import {
  interstitialPage,
  serverErrorPage,
  sessionExpiredPage,
} from "./views/pages.js"

export const createApp = (): Hono<AppEnv> => {
  const app = new Hono<AppEnv>()

  // Out-of-band control first, and outside the tenant namespace entirely.
  registerControlRoutes(app)

  app.get("/", (c) => c.redirect(`/${defaultTenantId}/login`, 302))

  // Resolve the tenant for every tenant-scoped request. The path pattern only
  // matches known tenant ids, so this cannot swallow `/__control/*`.
  app.use(tenantPath("/*"), async (c, next) => {
    const tenant = getTenant(c.req.param("tenant") ?? "")
    if (!tenant) return c.text("Unknown institution", 404)

    c.set("tenant", tenant)
    c.set("session", getSession(getCookie(c, SESSION_COOKIE)))

    await next()
  })

  /**
   * Runtime conditions, applied only to the signed-in desk. Ordered most severe
   * first: a hard error pre-empts an expired session, which pre-empts a notice.
   */
  const deskGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
    const tenant = c.get("tenant")

    if (consumeFault("server-error")) {
      return c.html(serverErrorPage(tenant), 500)
    }

    if (consumeFault("session-expired")) {
      expireSession(getCookie(c, SESSION_COOKIE))
      c.set("session", undefined)
      // Deliberately a 200. Legacy apps signal expiry in the page body, not the
      // status line — so only a real checkpoint catches it.
      return c.html(sessionExpiredPage(tenant))
    }

    if (!c.get("session")) {
      return c.html(sessionExpiredPage(tenant))
    }

    // Interstitials interrupt navigation, not submissions — a POST body would be
    // lost, and that is not the condition being modelled.
    if (c.req.method === "GET" && consumeFault("interstitial")) {
      return c.html(interstitialPage(tenant, c.req.path))
    }

    await next()
  }

  // `/desk` (the frameset) and `/desk/*` (every frame and action) both need it.
  app.use(tenantPath("/desk"), deskGuard)
  app.use(tenantPath("/desk/*"), deskGuard)

  registerAuthRoutes(app)
  registerDeskRoutes(app)

  app.notFound((c) => c.text("Not found", 404))

  return app
}
