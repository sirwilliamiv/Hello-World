import type { DashboardWidgetsSlot } from '@forge/kernel-ui'

// Seeded by Forge from kernel.ui@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called when the dashboard is composed.
// Client-specific widget selection and arrangement.

export const dashboardWidgets: DashboardWidgetsSlot = async (ctx) => {
  return ctx.proceed()
}
