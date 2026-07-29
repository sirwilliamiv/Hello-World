import type { RetentionRulesSlot } from '@forge/data-files'

// Seeded by Forge from data.files@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called when the retention sweep runs.
// Client-specific retention and expiry.

export const retentionRules: RetentionRulesSlot = async (ctx) => {
  return ctx.proceed()
}
