"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { Badge } from "@workspace/ui/components/badge"
import { cn } from "@workspace/ui/lib/utils"

import { useApiQuery, queryKeys } from "@/lib/query"

/**
 * The console frame.
 *
 * Four places, in the order the system works: what it can do, what it did, what
 * needs a person, and a way to try one. The intervention count lives in the nav
 * and polls, because a paused run is the one thing in this system that is
 * waiting on the operator rather than the other way round.
 */

const LINKS = [
  { href: "/", label: "Capabilities" },
  { href: "/runs", label: "Runs" },
  { href: "/interventions", label: "Interventions" },
] as const

function InterventionCount() {
  // Poll rather than push: an inbox that is a few seconds stale is fine, and a
  // second WebSocket purely to keep a number fresh is not worth its failure modes.
  const query = useApiQuery(
    queryKeys.interventions,
    (client) => client.interventions.list(),
    { refetchInterval: 3_000 }
  )

  const open =
    query.data?._tag === "Right"
      ? query.data.right.filter(
          (intervention) => intervention.status !== "resolved"
        ).length
      : 0

  if (open === 0) return null

  return <Badge variant="destructive">{open}</Badge>
}

export function ConsoleShell({
  children,
}: {
  readonly children: React.ReactNode
}) {
  const pathname = usePathname()

  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-6 px-6 py-3">
          <Link href="/" className="flex items-baseline gap-2">
            <span className="font-mono text-sm font-semibold">cua</span>
            <span className="text-xs text-muted-foreground">
              operator console
            </span>
          </Link>

          <nav className="flex items-center gap-1">
            {LINKS.map((link) => {
              const active =
                link.href === "/"
                  ? pathname === "/" || pathname.startsWith("/capabilities")
                  : pathname.startsWith(link.href)

              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
                    active
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {link.label}
                  {link.href === "/interventions" ? <InterventionCount /> : null}
                </Link>
              )
            })}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        {children}
      </main>
    </div>
  )
}
