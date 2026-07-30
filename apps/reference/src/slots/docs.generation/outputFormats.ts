import type { OutputFormatsSlot } from '@forge/docs-generation'

// Seeded by Forge from docs.generation@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called when an output format is selected.
// Client-specific output formats beyond PDF and HTML.

export const outputFormats: OutputFormatsSlot = async (ctx) => {
  return ctx.proceed()
}
