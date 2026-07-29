import type { NavigationOrderSlot } from '@forge/kernel-ui'

// Seeded by Forge from kernel.ui@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called when the nav registry is resolved.
// Client-specific ordering and grouping of registered navigation entries.

export const navigationOrder: NavigationOrderSlot = async (ctx) => {
  return ctx.proceed()
}
