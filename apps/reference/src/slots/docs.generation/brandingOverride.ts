import type { BrandingOverrideSlot } from '@forge/docs-generation'

// Seeded by Forge from docs.generation@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called when document styling is resolved.
// Per-document-type branding that differs from the application's kernel.ui tokens, such as a letterhead.

export const brandingOverride: BrandingOverrideSlot = async (ctx) => {
  return ctx.proceed()
}
