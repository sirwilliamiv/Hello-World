import type { PostLoginRedirectSlot } from '@forge/kernel-identity'

// Seeded by Forge from kernel.identity@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called after a successful login.
// Where a user lands, which is usually role-dependent.

export const postLoginRedirect: PostLoginRedirectSlot = async (ctx) => {
  return ctx.proceed()
}
