import type { EntityDisplayConfigSlot } from '@forge/kernel-admin'

// Seeded by Forge from kernel.admin@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called when admin columns and labels are resolved.
// Client-specific column selection, ordering, and labelling.

export const entityDisplayConfig: EntityDisplayConfigSlot = async (ctx) => {
  return ctx.proceed()
}
