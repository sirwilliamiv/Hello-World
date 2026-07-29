/**
 * The four extension points `data.files` declares. Their *types* live here, in the
 * package, so a signature change in a major version breaks the client's slot file at
 * compile time — loud, local, fixable (ARCHITECTURE.md section 4).
 *
 * Every slot is optional. The behaviour with no slot installed is the configured
 * behaviour, so a client that customises nothing still gets a working capability.
 */
import type { EntityAttachment, FileRecord } from './types.js'

export type MaybePromise<T> = T | Promise<T>

export interface SlotUser {
  readonly id: string
  readonly [key: string]: unknown
}

// ── allowedTypes ────────────────────────────────────────────────────────────────

export interface AllowedTypesContext {
  readonly filename: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly user: SlotUser | null
  readonly attachedTo: EntityAttachment | undefined
  /** The content types from configuration, already checked. */
  readonly configured: readonly string[]
  /** What the capability would decide on its own. */
  readonly allowedByConfig: boolean
}

export interface AllowedTypesDecision {
  readonly allow: boolean
  readonly reason?: string
}

/** "Client-specific content-type rules beyond the configured list." */
export type AllowedTypesSlot = (ctx: AllowedTypesContext) => MaybePromise<AllowedTypesDecision>

// ── sizeLimits ──────────────────────────────────────────────────────────────────

export interface SizeLimitsContext {
  readonly filename: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly user: SlotUser | null
  readonly attachedTo: EntityAttachment | undefined
  /** `maxSizeBytes` from configuration. */
  readonly configuredMaxBytes: number
}

export interface SizeLimitsDecision {
  /** The effective ceiling. A slot may lower it or (deliberately) raise it. */
  readonly maxSizeBytes: number
  readonly reason?: string
}

/** "Client-specific size limits, usually per entity or per role." */
export type SizeLimitsSlot = (ctx: SizeLimitsContext) => MaybePromise<SizeLimitsDecision>

// ── processingPipeline ──────────────────────────────────────────────────────────

/** A derived object the pipeline produced — a thumbnail, a redacted copy, a preview. */
export interface ProcessingOutput {
  readonly kind: string
  readonly storageKey: string
  readonly width?: number
  readonly height?: number
}

export interface ProcessingContext {
  readonly file: Readonly<FileRecord>
  /** Read the scanned, clean bytes. */
  read(): Promise<Uint8Array>
  /** Write a derived object; returns the key it was written under. */
  write(kind: string, bytes: Uint8Array, contentType: string): Promise<string>
  /** Hand slow work to the durable queue rather than blocking the scan job. */
  enqueue(kind: string, payload: Record<string, unknown>): Promise<void>
}

/**
 * "Client-specific derivation work: resizing, redaction, format conversion."
 * Runs *after* a file clears scanning and before `file.uploaded` is published, so a
 * pipeline never sees unscanned bytes.
 */
export type ProcessingPipelineSlot = (
  ctx: ProcessingContext,
) => MaybePromise<readonly ProcessingOutput[]>

// ── retentionRules ──────────────────────────────────────────────────────────────

export interface RetentionContext {
  readonly file: Readonly<FileRecord>
  /** Sweep time, injected rather than read from the clock, so sweeps are testable. */
  readonly now: Date
  readonly ageDays: number
}

export type RetentionDecision =
  | { readonly action: 'keep' }
  | { readonly action: 'delete'; readonly reason: string }

/** "Client-specific retention and expiry." */
export type RetentionRulesSlot = (ctx: RetentionContext) => MaybePromise<RetentionDecision>

// ── the bundle the generated config passes in ───────────────────────────────────

/**
 * `src/generated/data.files/config.ts` does `import * as slots from '@/slots/data.files'`
 * and hands the namespace over whole, so every member is optional and unknown members
 * are ignored.
 */
export interface FilesSlots {
  allowedTypes: AllowedTypesSlot
  sizeLimits: SizeLimitsSlot
  processingPipeline: ProcessingPipelineSlot
  retentionRules: RetentionRulesSlot
}

export type FilesSlotsInput = Partial<FilesSlots>
