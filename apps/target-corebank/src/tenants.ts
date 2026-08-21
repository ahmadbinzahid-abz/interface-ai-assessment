/**
 * Two tenants running the *same vendor product*, configured and branded
 * differently — the situation described in the brief, where hundreds of
 * institutions share one underlying application.
 *
 * The differences are chosen to be exactly the ones that break naive automation:
 * different field labels (so a locator keyed on visible text fails), different
 * button captions, and different table nesting (so a positional selector fails
 * while a relational anchor still resolves).
 *
 * A capability recorded against `firstcity` should replay against `riverbend`
 * through a thin per-tenant overlay rather than being re-recorded.
 */
export interface TenantVariant {
  readonly id: string
  readonly institution: string
  /** Same vendor product, different deployed version. */
  readonly productVersion: string
  readonly vocabulary: {
    readonly memberIdLabel: string
    readonly searchButton: string
    readonly savingsLabel: string
    readonly subAccountHeading: string
    readonly openSubAccountButton: string
  }
  /**
   * Riverbend wraps page content in an extra nested table. Harmless to a human,
   * fatal to a recorded CSS path, invisible to a role+name lookup.
   */
  readonly extraTableNesting: boolean
  readonly accent: string
}

const firstcity: TenantVariant = {
  id: "firstcity",
  institution: "First City Credit Union",
  productVersion: "8.4.1",
  vocabulary: {
    memberIdLabel: "Member Number",
    searchButton: "Search",
    savingsLabel: "Savings",
    subAccountHeading: "Open Sub-Account",
    openSubAccountButton: "Open Sub-Account",
  },
  extraTableNesting: false,
  accent: "#123a6b",
}

const riverbend: TenantVariant = {
  id: "riverbend",
  institution: "Riverbend Federal CU",
  productVersion: "8.4.7",
  vocabulary: {
    memberIdLabel: "Member #",
    searchButton: "Find Member",
    savingsLabel: "Regular Savings",
    subAccountHeading: "New Sub Account",
    openSubAccountButton: "New Sub Account",
  },
  extraTableNesting: true,
  accent: "#2f5d3a",
}

const tenants = new Map<string, TenantVariant>([
  [firstcity.id, firstcity],
  [riverbend.id, riverbend],
])

export const defaultTenantId = firstcity.id

export const getTenant = (id: string): TenantVariant | undefined =>
  tenants.get(id)

export const listTenants = (): readonly TenantVariant[] => [...tenants.values()]
