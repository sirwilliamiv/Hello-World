/**
 * The four extension points `data.files` declares. Their *types* live here, in the
 * package, so a signature change in a major version breaks the client's slot file at
 * compile time — loud, local, fixable (ARCHITECTURE.md section 4).
 *
 * Every slot is optional. The behaviour with no slot installed is the configured
 * behaviour, so a client that customises nothing still gets a working capability.
 *
 * Every context carries `proceed()`, returning exactly what the capability does with
 * no slot implemented (schemas/capability.schema.json, `$defs.slot.signature`). That
 * is what makes the seeded stub a correct one-liner:
 *
 *     export const allowedTypes: AllowedTypesSlot = async (ctx) => ctx.proceed()
 *
 * and what lets a client change one branch and defer on the rest.
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
  /**
   * The configured `allowedContentTypes` — exactly what is accepted with no slot
   * installed. Return it to defer; return a subset to narrow, which is the case this
   * slot mostly exists for:
   *
   *     ctx.attachedTo?.entity === 'Receipt'
   *       ? ctx.proceed().filter((t) => t.startsWith('image/'))
   *       : ctx.proceed()
   */
  proceed(): readonly string[]
}

export interface AllowedTypesDecision {
  readonly allow: boolean
  readonly reason?: string
}

/**
 * A list of accepted content types — the upload is accepted when it names this
 * upload's type — or an explicit decision when the client wants to say why.
 */
export type AllowedTypesResult = readonly string[] | AllowedTypesDecision

/** "Client-specific content-type rules beyond the configured list." */
export type AllowedTypesSlot = (ctx: AllowedTypesContext) => MaybePromise<AllowedTypesResult>

/** Normalises either shape into the decision the upload path acts on. */
export function allowedTypesDecision(
  result: AllowedTypesResult,
  contentType: string,
): AllowedTypesDecision {
  return Array.isArray(result) ? { allow: result.includes(contentType) } : (result as AllowedTypesDecision)
}

// ── sizeLimits ──────────────────────────────────────────────────────────────────

export interface SizeLimitsContext {
  readonly filename: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly user: SlotUser | null
  readonly attachedTo: EntityAttachment | undefined
  /** `maxSizeBytes` from configuration. */
  readonly configuredMaxBytes: number
  /** The configured `maxSizeBytes` — the ceiling that applies with no slot installed. */
  proceed(): number
}

export interface SizeLimitsDecision {
  /** The effective ceiling. A slot may lower it or (deliberately) raise it. */
  readonly maxSizeBytes: number
  readonly reason?: string
}

/** The effective ceiling, or a decision carrying the message to reject with. */
export type SizeLimitsResult = number | SizeLimitsDecision

/** "Client-specific size limits, usually per entity or per role." */
export type SizeLimitsSlot = (ctx: SizeLimitsContext) => MaybePromise<SizeLimitsResult>

export function sizeLimitsDecision(result: SizeLimitsResult): SizeLimitsDecision {
  return typeof result === 'number' ? { maxSizeBytes: result } : result
}

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
  /**
   * No derived objects. The capability ships no pipeline of its own — a thumbnail
   * of an arbitrary client's file is not something it can guess at — so the default
   * is an empty list and `file.processed` is not published.
   */
  proceed(): readonly ProcessingOutput[]
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

export type RetentionDecision =
  | { readonly action: 'keep' }
  | { readonly action: 'delete'; readonly reason: string }

export interface RetentionContext {
  readonly file: Readonly<FileRecord>
  /** Sweep time, injected rather than read from the clock, so sweeps are testable. */
  readonly now: Date
  readonly ageDays: number
  /**
   * Keep the file. The capability ships no retention policy — deleting a client's
   * files on a guess is not a sensible default — so nothing expires until a slot
   * says it does.
   */
  proceed(): RetentionDecision
  /** Delete the file and its stored objects, recording `reason` on the cascade. */
  expire(reason: string): RetentionDecision
}

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
