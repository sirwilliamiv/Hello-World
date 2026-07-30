import type { PriorityRulesSlot } from '@forge/ops-queue'

// Seeded by Forge from ops.queue@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called when the next job is selected.
// Client-specific prioritisation.

export const priorityRules: PriorityRulesSlot = async (ctx) => {
  return ctx.proceed()
}
