/**
 * The upload half of the lifecycle: authorise, grant, confirm, hand to the scanner.
 *
 * The application never sees a byte of an upload. It issues a signed grant, the
 * browser PUTs to storage, and the application confirms what storage received. That
 * is why `completeUpload` re-reads the object's real size instead of trusting the
 * size the client declared.
 */
import { randomUUID } from 'node:crypto'
import { files } from './config.js'
import { UploadRejectedError, FileNotFoundError } from './errors.js'
import { originalKey } from './keys.js'
import { repositories } from './repositories.js'
import { SCAN_JOB_KIND } from './scanning.js'
import {
  type FileRecord,
  type ServerFileInput,
  type UploadInput,
  type UploadSession,
} from './types.js'

/** Config list, then the client's `allowedTypes` slot, then the size slot. */
async function authoriseUpload(input: {
  filename: string
  contentType: string
  sizeBytes: number
  attachedTo: UploadInput['attachedTo']
  user: { id: string } | null
}): Promise<{ maxSizeBytes: number }> {
  const cfg = files()
  const allowedByConfig = cfg.allowedContentTypes.includes(input.contentType)

  const typeSlot = cfg.slots.allowedTypes
  const decision =
    typeSlot === undefined
      ? { allow: allowedByConfig }
      : await typeSlot({
          filename: input.filename,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          user: input.user,
          attachedTo: input.attachedTo,
          configured: cfg.allowedContentTypes,
          allowedByConfig,
        })

  if (!decision.allow) {
    throw new UploadRejectedError(
      decision.reason ??
        `Content type ${input.contentType} is not accepted. Allowed: ${cfg.allowedContentTypes.join(', ')}`,
    )
  }

  const sizeSlot = cfg.slots.sizeLimits
  const limit =
    sizeSlot === undefined
      ? { maxSizeBytes: cfg.maxSizeBytes }
      : await sizeSlot({
          filename: input.filename,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          user: input.user,
          attachedTo: input.attachedTo,
          configuredMaxBytes: cfg.maxSizeBytes,
        })

  if (input.sizeBytes <= 0) {
    throw new UploadRejectedError('An upload must declare a positive size in bytes.')
  }
  if (input.sizeBytes > limit.maxSizeBytes) {
    throw new UploadRejectedError(
      limit.reason ??
        `File is ${input.sizeBytes} bytes; the limit for this upload is ${limit.maxSizeBytes}.`,
    )
  }
  return { maxSizeBytes: limit.maxSizeBytes }
}

/**
 * `upload(input) -> UploadSession`. Returns a signed direct-to-storage grant.
 * The File row exists from this moment but is not retrievable and will not be until
 * it has cleared scanning.
 */
export async function upload(input: UploadInput): Promise<UploadSession> {
  const cfg = files()
  const repos = await repositories()
  const user = await repos.currentUser()
  const ownerId = input.ownerId ?? user?.id ?? null

  const { maxSizeBytes } = await authoriseUpload({
    filename: input.filename,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    attachedTo: input.attachedTo,
    user,
  })

  const id = randomUUID()
  const now = new Date()
  const storageKey = originalKey(cfg.keyPrefix, id, input.filename)

  await repos.files.create({
    id,
    filename: input.filename,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    ownerId,
    checksum: null,
    storageKey,
    status: 'awaiting_upload',
    scanStatus: 'pending',
    scanner: null,
    quarantineReason: null,
    attachedToEntity: input.attachedTo?.entity ?? null,
    attachedToId: input.attachedTo?.id ?? null,
    createdAt: now,
    updatedAt: now,
  })

  const ttlSeconds = input.ttlSeconds ?? cfg.uploadTtlSeconds
  const grant = await cfg.storage.signedUploadUrl(storageKey, {
    contentType: input.contentType,
    ttlSeconds,
    maxSizeBytes,
  })

  const sessionId = randomUUID()
  await repos.sessions.create({
    id: sessionId,
    fileId: id,
    storageKey,
    method: grant.method,
    url: grant.url,
    contentType: input.contentType,
    maxSizeBytes,
    ownerId,
    expiresAt: grant.expiresAt,
    completedAt: null,
    createdAt: now,
  })

  return {
    id: sessionId,
    fileId: id,
    url: grant.url,
    method: grant.method,
    headers: grant.headers,
    expiresAt: grant.expiresAt,
    maxSizeBytes,
  }
}

/**
 * Called once the client has PUT the bytes. Moves the file from `awaiting_upload`
 * to `scanning` and hands the scan to the durable queue — never inline, because a
 * scan outlives a request and must survive a restart.
 */
export async function completeUpload(sessionId: string, now: Date = new Date()): Promise<FileRecord> {
  const cfg = files()
  const repos = await repositories()

  const session = await repos.sessions.find(sessionId)
  if (session === null) throw new FileNotFoundError(sessionId)

  const file = await repos.files.find(session.fileId)
  if (file === null) throw new FileNotFoundError(session.fileId)

  // Replaying the confirmation is not an error; the queue may do it.
  if (session.completedAt !== null) return file

  if (session.expiresAt.getTime() <= now.getTime()) {
    throw new UploadRejectedError('The upload grant has expired. Request a new one.')
  }

  const head = await cfg.storage.head(session.storageKey)
  if (head === null) {
    throw new UploadRejectedError('No object was uploaded against this grant.')
  }
  if (head.sizeBytes > session.maxSizeBytes) {
    // Storage accepted more than we authorised. Remove it rather than scan it.
    await cfg.storage.delete(session.storageKey)
    await repos.files.update(file.id, { status: 'deleted', updatedAt: now })
    throw new UploadRejectedError(
      `Uploaded object is ${head.sizeBytes} bytes, over the ${session.maxSizeBytes} byte limit.`,
    )
  }

  const updated = await repos.files.update(file.id, {
    sizeBytes: head.sizeBytes,
    status: 'scanning',
    scanStatus: 'pending',
    updatedAt: now,
  })
  await repos.sessions.update(sessionId, { completedAt: now })
  await repos.versions.create({
    id: randomUUID(),
    fileId: file.id,
    version: 1,
    storageKey: session.storageKey,
    sizeBytes: head.sizeBytes,
    checksum: null,
    createdAt: now,
  })

  await repos.enqueue({
    kind: SCAN_JOB_KIND,
    payload: { fileId: file.id },
    idempotencyKey: `${SCAN_JOB_KIND}:${file.id}`,
  })

  return updated
}

/**
 * Server-side ingest for bytes the application produced itself — a rendered
 * document, a generated export. Not in the capability's `exposes` block; see the
 * report. It takes the identical path as a browser upload, scanning included, so
 * "an unscanned object is never accessible" holds for internally produced files too.
 */
export async function storeServerFile(input: ServerFileInput, now: Date = new Date()): Promise<FileRecord> {
  const cfg = files()
  const repos = await repositories()
  const user = await repos.currentUser()
  const ownerId = input.ownerId ?? user?.id ?? null

  await authoriseUpload({
    filename: input.filename,
    contentType: input.contentType,
    sizeBytes: input.bytes.byteLength,
    attachedTo: input.attachedTo,
    user,
  })

  const id = randomUUID()
  const storageKey = input.storageKey ?? originalKey(cfg.keyPrefix, id, input.filename)

  await cfg.storage.put(storageKey, input.bytes, input.contentType)

  await repos.files.create({
    id,
    filename: input.filename,
    contentType: input.contentType,
    sizeBytes: input.bytes.byteLength,
    ownerId,
    checksum: null,
    storageKey,
    status: 'scanning',
    scanStatus: 'pending',
    scanner: null,
    quarantineReason: null,
    attachedToEntity: input.attachedTo?.entity ?? null,
    attachedToId: input.attachedTo?.id ?? null,
    createdAt: now,
    updatedAt: now,
  })
  await repos.versions.create({
    id: randomUUID(),
    fileId: id,
    version: 1,
    storageKey,
    sizeBytes: input.bytes.byteLength,
    checksum: null,
    createdAt: now,
  })

  await repos.enqueue({
    kind: SCAN_JOB_KIND,
    payload: { fileId: id },
    idempotencyKey: `${SCAN_JOB_KIND}:${id}`,
  })

  const stored = await repos.files.find(id)
  if (stored === null) throw new FileNotFoundError(id)
  return stored
}
