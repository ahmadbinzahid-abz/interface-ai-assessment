import { Geist_Mono, Inter } from "next/font/google"

import "@workspace/ui/globals.css"
import { ConsoleShell } from "@/components/common/layout/console-shell"
import { Providers } from "@/components/providers"
import { cn } from "@workspace/ui/lib/utils"

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" })

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

export const metadata = {
  title: "cua — operator console",
  description:
    "Capabilities, runs, evidence, and the interventions waiting for a person.",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        "antialiased",
        fontMono.variable,
        "font-sans",
        inter.variable
      )}
    >
      <body>
        <Providers>
          <ConsoleShell>{children}</ConsoleShell>
        </Providers>
      </body>
    </html>
  )
}
