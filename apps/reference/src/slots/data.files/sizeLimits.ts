import type { SizeLimitsSlot } from '@forge/data-files'

// Seeded by Forge from data.files@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called when an upload is authorised.
// Client-specific size limits, usually per entity or per role.

export const sizeLimits: SizeLimitsSlot = async (ctx) => {
  return ctx.proceed()
}
