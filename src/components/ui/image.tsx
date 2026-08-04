"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Standard shadcn-style Image component.
 *
 * A thin wrapper around a native <img> with the project's design tokens —
 * rounded border, object-cover fit, and an optional aspect-ratio prop.
 * Used by the file viewer to render attached/mentioned images (which arrive
 * as base64 data URLs from the main process, since the renderer can't load
 * file:// URLs under contextIsolation).
 *
 * No next/image dependency (this is Electron + Vite, not Next.js).
 */
function Image({
  className,
  aspectRatio = "auto",
  ...props
}: React.ComponentProps<"img"> & {
  /**
   * Forces a fixed aspect ratio box so images don't blow up the layout.
   * "auto" preserves the natural ratio; the named ratios match common
   * viewport shapes for preview cards.
   */
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
