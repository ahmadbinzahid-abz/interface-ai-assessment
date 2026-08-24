"use client"

import { queryKeys, useApiQuery } from "@/lib/query"

export const useCapabilities = () =>
  useApiQuery(queryKeys.capabilities, (client) => client.capabilities.list())

export const useCapability = (name: string, version: string) =>
  useApiQuery(queryKeys.capability(name, version), (client) =>
    client.capabilities.findByName({ path: { name, version } })
  )
