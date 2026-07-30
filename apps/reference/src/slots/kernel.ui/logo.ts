import type { LogoSlot } from '@forge/kernel-ui'

// Seeded by Forge from kernel.ui@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called when the shell renders the brand mark.
// Client logo component, for cases a static asset cannot express.

export const logo: LogoSlot = async (ctx) => {
  return ctx.proceed()
}
