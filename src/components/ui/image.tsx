"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/** Standard shadcn-style Image component: thin wrapper over <img> with rounded border + object-cover + optional aspect-ratio. Used by the file viewer for base64 data URLs (renderer can't load file:// under contextIsolation). */
function Image({
  className,
  aspectRatio = "auto",
  ...props
}: React.ComponentProps<"img"> & {
  /** Forces a fixed aspect ratio box ("auto" = natural ratio; named ratios = common preview shapes). */
  aspectRatio?: "auto" | "square" | "video" | "wide"
}) {
  return (
    <img
      data-slot="image"
      data-aspect={aspectRatio}
      className={cn(
        "rounded-md border border-border object-cover",
        "data-[aspect=square]:aspect-square data-[aspect=video]:aspect-video data-[aspect=wide]:aspect-[21/9]",
        className
      )}
      {...props}
    />
  )
}

export { Image }
