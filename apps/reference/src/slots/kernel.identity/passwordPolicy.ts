import type { PasswordPolicySlot } from '@forge/kernel-identity'

// Seeded by Forge from kernel.identity@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called on password set or change.
// Client-specific complexity and reuse rules.

export const passwordPolicy: PasswordPolicySlot = async (ctx) => {
  return ctx.proceed()
}
