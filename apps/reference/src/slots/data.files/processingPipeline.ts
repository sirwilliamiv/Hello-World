import type { ProcessingPipelineSlot } from '@forge/data-files'

// Seeded by Forge from data.files@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called after a file clears scanning.
// Client-specific derivation work: resizing, redaction, format conversion.

export const processingPipeline: ProcessingPipelineSlot = async (ctx) => {
  return ctx.proceed()
}
