import { CapabilityList } from "@/features/capabilities/components/capability-list"

export default function Page() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Capabilities</h1>
        <p className="text-sm text-muted-foreground">
          Compiled artifacts an agent invokes by name. Each one was discovered
          once by a model and replays with no model in the decision loop.
        </p>
      </div>

      <CapabilityList />
    </div>
  )
}
