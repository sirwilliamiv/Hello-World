import type { AllowedTypesSlot } from '@forge/data-files'

// Seeded by Forge from data.files@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called when an upload is authorised.
// Client-specific content-type rules beyond the configured list.

export const allowedTypes: AllowedTypesSlot = async (ctx) => {
  return ctx.proceed()
}
