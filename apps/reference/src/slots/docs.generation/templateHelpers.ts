import type { TemplateHelpersSlot } from '@forge/docs-generation'

// Seeded by Forge from docs.generation@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called when a template is compiled.
// Client-specific formatting helpers available to every template.

export const templateHelpers: TemplateHelpersSlot = async (ctx) => {
  return ctx.proceed()
}
