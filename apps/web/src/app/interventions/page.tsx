import { InterventionInbox } from "@/features/interventions/components/intervention-inbox"

export default function Page() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Interventions</h1>
        <p className="text-sm text-muted-foreground">
          Paused runs, holding a live browser session open until somebody
          decides. They do not time out into failures — the state an operator
          needs is the state the run stopped in.
        </p>
      </div>

      <InterventionInbox />
    </div>
  )
}
