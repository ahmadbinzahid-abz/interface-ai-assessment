import { cn } from "@workspace/ui/lib/utils"
import { HugeiconsIcon } from "@hugeicons/react"
import { Loading03Icon } from "@hugeicons/core-free-icons"

/**
 * `strokeWidth` is omitted from the accepted props deliberately.
 *
 * `React.ComponentProps<"svg">` types it as `string | number`, while the icon
 * component accepts only `number` — so the registry's version does not compile
 * under `tsc --noEmit`. The spinner sets its own stroke anyway, so removing it
 * from the surface is both the smallest fix and the honest one.
 */
function Spinner({
  className,
  ...props
}: Omit<React.ComponentProps<"svg">, "strokeWidth">) {
  return (
    <HugeiconsIcon
      icon={Loading03Icon}
      strokeWidth={2}
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
