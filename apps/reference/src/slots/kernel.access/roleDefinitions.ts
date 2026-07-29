import type { RoleDefinitionsSlot } from '@forge/kernel-access'

// Seeded by Forge from kernel.access@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called at boot, when the role set is resolved.
// Client-specific roles beyond owner, admin, member, viewer.

export const roleDefinitions: RoleDefinitionsSlot = async (ctx) => {
  return ctx.proceed()
}
