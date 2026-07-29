import type { PermissionResolverSlot } from '@forge/kernel-access'

// Seeded by Forge from kernel.access@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called on every can() call not satisfied by a declared role.
// Client-specific permission logic.

export const permissionResolver: PermissionResolverSlot = async (ctx) => {
  return ctx.proceed()
}
