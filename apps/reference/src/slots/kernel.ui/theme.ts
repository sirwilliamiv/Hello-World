import type { ThemeSlot } from '@forge/kernel-ui'

// Seeded by Forge from kernel.ui@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called at token resolution.
// Client-specific token overrides beyond what manifest branding expresses.

export const theme: ThemeSlot = async (ctx) => {
  return ctx.proceed()
}
