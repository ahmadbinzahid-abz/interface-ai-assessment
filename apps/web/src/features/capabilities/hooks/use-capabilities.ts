"use client"

import { queryKeys, useApiQuery } from "@/lib/query"

export const useCapabilities = () =>
  useApiQuery(queryKeys.capabilities, (client) => client.capabilities.list())

/**
 * The artifact, optionally resolved for one institution.
 *
 * With a tenant, the server returns what would *actually execute* there rather
 * than the base plus an overlay for a reviewer to merge in their head. That is
 * the version worth reviewing, and it is the version that runs.
 */
export const useCapability = (
  name: string,
  version: string,
  tenant?: string
) =>
  useApiQuery([...queryKeys.capability(name, version), tenant ?? ""], (client) =>
    client.capabilities.findByName({
      path: { name, version },
      urlParams: { tenant },
    })
  )

/** The tool declarations a customer-facing agent would be given. */
export const useDeclarations = () =>
  useApiQuery(["capabilities", "declarations"], (client) =>
    client.capabilities.declarations()
  )

/** Institutions this capability carries an overlay for. */
export const useOverlayTenants = (
  name: string,
  version: string
): readonly string[] => {
  const query = useApiQuery(
    ["capabilities", name, version, "tenants"],
    (client) => client.capabilities.tenants({ path: { name, version } })
  )

  return query.data?._tag === "Right" ? query.data.right : []
}
