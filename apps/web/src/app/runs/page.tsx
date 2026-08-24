import { RunList } from "@/features/runs/components/run-list"

export default function Page() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Runs</h1>
        <p className="text-sm text-muted-foreground">
          Every discovery and replay that left evidence behind, newest first.
        </p>
      </div>

      <RunList />
    </div>
  )
}
