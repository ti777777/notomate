import * as React from "react"
import { cn } from "@/lib/utils"

/** Shared pulse placeholder. Compose these to build loading skeletons. */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-neutral-200 dark:bg-neutral-700", className)}
      {...props}
    />
  )
}

export { Skeleton }
