import { CapabilityDetail } from "@/features/capabilities/components/capability-detail"

/**
 * Route params are a promise in this version of Next, and awaiting them is what
 * marks the segment as dynamic.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ name: string; version: string }>
}) {
  const { name, version } = await params

  return <CapabilityDetail name={name} version={version} />
}
