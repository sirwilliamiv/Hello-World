import type { BulkActionSlot } from '@forge/kernel-admin'

// Seeded by Forge from kernel.admin@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called when the bulk action menu is built.
// Client-specific bulk operations.

export const bulkAction: BulkActionSlot = async (ctx) => {
  return ctx.proceed()
}
