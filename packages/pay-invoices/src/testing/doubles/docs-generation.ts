/**
 * Test double for @forge/docs-generation.
 *
 * It models the one property the contract test with docs.generation depends on:
 * `TemplateVersion` is append-only, so a template edit publishes a NEW version
 * and the old one keeps rendering exactly as it did. Asking for a pinned version
 * therefore yields byte-identical output after the template has been edited.
 */

import { createHash } from 'node:crypto'

export interface TemplateRef {
  readonly id: string
  readonly version?: string
}

export interface GeneratedDocument {
  readonly id: string
  readonly templateVersion: string
  readonly contentType: string
  readonly bytes: Uint8Array
}

interface StoredVersion {
  readonly version: string
  readonly body: string
}

const versions = new Map<string, StoredVersion[]>()
let documentSeq = 0

export function resetDocuments(): void {
  versions.clear()
  documentSeq = 0
}

/** Publishes a new, immutable version of a template. */
export function publishTemplateVersion(templateId: string, body: string): string {
  const list = versions.get(templateId) ?? []
  const version = `v${list.length + 1}`
  list.push({ version, body })
  versions.set(templateId, list)
  return version
}

function resolve(templateId: string, requested?: string): StoredVersion {
  let list = versions.get(templateId)
  if (list === undefined || list.length === 0) {
    publishTemplateVersion(templateId, `{{number}} | {{totalMinor}} {{currency}}`)
    list = versions.get(templateId) as StoredVersion[]
  }
  if (requested === undefined) return list[list.length - 1] as StoredVersion
  const found = list.find((v) => v.version === requested)
  if (found === undefined) {
    throw new Error(`no version ${requested} of template ${templateId}`)
  }
  return found
}

export async function generate(
  template: TemplateRef,
  data: unknown,
  opts?: { version?: string },
): Promise<GeneratedDocument> {
  const requested = opts?.version ?? template.version
  const chosen = resolve(template.id, requested)

  // Deterministic "render": the bytes depend on the template body and the data
  // only. No clock, no counter — otherwise a byte-identity test proves nothing.
  const rendered = `${chosen.body}\n${JSON.stringify(data)}`
  const bytes = new TextEncoder().encode(rendered)
  documentSeq += 1

  return {
    id: `doc_${createHash('sha256').update(rendered).digest('hex').slice(0, 12)}`,
    templateVersion: chosen.version,
    contentType: 'application/pdf',
    bytes,
  }
}

export function renderCount(): number {
  return documentSeq
}
