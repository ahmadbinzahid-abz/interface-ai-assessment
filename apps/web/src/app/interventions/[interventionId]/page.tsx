import { LiveControl } from "@/features/interventions/live-control/components/live-control"

export default async function Page({
  params,
}: {
  params: Promise<{ interventionId: string }>
}) {
  const { interventionId } = await params

  return <LiveControl interventionId={interventionId} />
}
