import type { CustomAdminViewSlot } from '@forge/kernel-admin'

// Seeded by Forge from kernel.admin@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called when an entity's admin view is resolved.
// Replaces the generated view for a specific entity with a client-specific one.

export const customAdminView: CustomAdminViewSlot = async (ctx) => {
  return ctx.proceed()
}
