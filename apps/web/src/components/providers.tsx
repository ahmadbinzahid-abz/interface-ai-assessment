"use client"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TooltipProvider } from "@workspace/ui/components/tooltip"
import { useState } from "react"

import { ThemeProvider } from "@/components/theme-provider"

/**
 * The client-side providers, created once per browser session.
 *
 * `useState` rather than a module constant: a `QueryClient` at module scope is
 * shared across requests on the server, which leaks one operator's cached run
 * list into another's page. Cheap to get right, unpleasant to find later.
 */
export function Providers({ children }: { readonly children: React.ReactNode }) {
  const [queries] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // The console reads live operational state. A cached run list that
            // says "Running" for a run that finished a minute ago is worse than
            // a refetch.
            staleTime: 0,
            refetchOnWindowFocus: true,
            retry: 1,
          },
        },
      })
  )

  return (
    <QueryClientProvider client={queries}>
      <ThemeProvider>
        <TooltipProvider>{children}</TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
