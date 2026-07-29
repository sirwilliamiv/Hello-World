/**
 * The template store. `TemplateVersion` is append-only, and this file is the only
 * writer, so the guarantee is checkable by reading one module: there is no code path
 * that mutates a published version's source. Editing a template inserts a new row and
 * moves the template's `currentVersion` pointer; renderings that pinned the old
 * version keep rendering the old source, for ever.
 */
import { createHash, randomUUID } from 'node:crypto'
import { TemplateNotFoundError, TemplateVersionNotFoundError } from './errors.js'
import { runtime } from './ports.js'
import { compile } from './template-engine.js'
import {
  DOCUMENT_ENTITIES,
  templateKeyOf,
  type DocumentTemplate,
  type TemplateRef,
  type TemplateVersion,
} from './types.js'

export function sourceHash(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

async function stores() {
  const rt = await runtime()
  return {
    templates: rt.repository<DocumentTemplate>(DOCUMENT_ENTITIES.template),
    versions: rt.repository<TemplateVersion>(DOCUMENT_ENTITIES.templateVersion),
    publish: rt.publish,
    currentUser: rt.currentUser,
  }
}

export interface CreateTemplateInput {
  key: string
  name: string
  source: string
  description?: string
}

/** Creates a template and publishes version 1 of its source. */
export async function createTemplate(input: CreateTemplateInput): Promise<{
  template: DocumentTemplate
  version: TemplateVersion
}> {
  // Compiling here means a syntax error is reported when someone saves a template,
  // not when a customer asks for their invoice.
  compile(input.source)

  const { templates, versions, currentUser, publish } = await stores()
  const existing = await templates.findMany({ key: input.key })
  if (existing.length > 0) {
    const template = existing[0] as DocumentTemplate
    return { template, version: await publishTemplateVersion(template.id, input.source) }
  }

  const now = new Date()
  const id = randomUUID()
  const template = await templates.create({
    id,
    key: input.key,
    name: input.name,
    description: input.description ?? null,
    currentVersion: 1,
    createdAt: now,
    updatedAt: now,
  })
  const user = await currentUser()
  const version = await versions.create({
    id: randomUUID(),
    templateId: id,
    version: 1,
    source: input.source,
    sourceHash: sourceHash(input.source),
    createdBy: user?.id ?? null,
    createdAt: now,
  })
  await publish('document.template.updated', {
    template_id: id,
    version: 1,
    ...(user === null ? {} : { actor: user.id }),
  })
  return { template, version }
}

/**
 * Appends a new version. Never touches an existing one — that is the entire reason
 * the table is append-only, and why a document issued last quarter cannot be
 * restyled by an edit made today.
 */
export async function publishTemplateVersion(
  templateId: string,
  source: string,
): Promise<TemplateVersion> {
  compile(source)
  const { templates, versions, currentUser, publish } = await stores()

  const template = await templates.find(templateId)
  if (template === null) throw new TemplateNotFoundError(templateId)

  const next = template.currentVersion + 1
  const user = await currentUser()
  const version = await versions.create({
    id: randomUUID(),
    templateId,
    version: next,
    source,
    sourceHash: sourceHash(source),
    createdBy: user?.id ?? null,
    createdAt: new Date(),
  })
  await templates.update(templateId, { currentVersion: next, updatedAt: new Date() })
  await publish('document.template.updated', {
    template_id: templateId,
    version: next,
    ...(user === null ? {} : { actor: user.id }),
  })
  return version
}

export async function findTemplate(ref: TemplateRef): Promise<DocumentTemplate> {
  const { templates } = await stores()
  const parsed = templateKeyOf(ref)

  if (parsed.id !== undefined) {
    const byId = await templates.find(parsed.id)
    if (byId !== null) return byId
  }
  if (parsed.key !== undefined) {
    const byKey = await templates.findMany({ key: parsed.key })
    if (byKey.length > 0) return byKey[0] as DocumentTemplate
    // A key that happens to be an id is a convenience the caller should not have to
    // think about.
    const byId = await templates.find(parsed.key)
    if (byId !== null) return byId
  }
  throw new TemplateNotFoundError(JSON.stringify(ref))
}

export async function getTemplateVersion(
  templateId: string,
  version: number,
): Promise<TemplateVersion> {
  const { versions } = await stores()
  const rows = await versions.findMany({ templateId, version })
  const row = rows[0]
  if (row === undefined) throw new TemplateVersionNotFoundError(templateId, version)
  return row
}

/**
 * Resolves a reference to the exact version a rendering will pin. Explicit pin wins,
 * then the ref's own version, then the template's current version.
 */
export async function resolveTemplateVersion(
  ref: TemplateRef,
  explicitVersion?: number,
): Promise<{ template: DocumentTemplate; version: TemplateVersion }> {
  const template = await findTemplate(ref)
  const parsed = templateKeyOf(ref)
  const wanted = explicitVersion ?? parsed.version ?? template.currentVersion
  return { template, version: await getTemplateVersion(template.id, wanted) }
}

export async function listTemplates(): Promise<DocumentTemplate[]> {
  const { templates } = await stores()
  const all = await templates.findMany()
  return all.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

export async function listTemplateVersions(templateId: string): Promise<TemplateVersion[]> {
  const { versions } = await stores()
  const all = await versions.findMany({ templateId })
  return all.sort((a, b) => a.version - b.version)
}
