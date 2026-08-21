import type { Session } from "./session.js"
import { listTenants, type TenantVariant } from "./tenants.js"

export interface AppEnv {
  Variables: {
    tenant: TenantVariant
    session: Session | undefined
  }
}

/**
 * Routes are registered against an explicit list of known tenants rather than a
 * bare `:tenant` wildcard, so that out-of-band paths like `/__control/*` cannot
 * be mistaken for a tenant.
 */
const tenantPattern = listTenants()
  .map((tenant) => tenant.id)
  .join("|")

export const tenantPath = (suffix: string): string =>
  `/:tenant{${tenantPattern}}${suffix}`
