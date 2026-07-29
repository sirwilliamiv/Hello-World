/**
 * Scanning is the reason this capability exists in the shape it does.
 *
 * An uploaded object is quarantined — `status: 'scanning'`, not retrievable by any
 * path — until a scanner clears it. `file.uploaded` is published on the transition
 * into `available` and nowhere else, so a downstream consumer cannot receive an
 * event for an object that has not been scanned.
 *
 * The job runs on `ops.queue` rather than `kernel.work` because a scan is slow and a
 * lost scan means a file that is quarantined forever. A replayed job is a no-op, so
 * a restart mid-scan resumes rather than duplicating work.
 */
import { files } from './config.js'
import { ScannerUnavailableError } from './errors.js'
import { repositories } from './repositories.js'
import { sha256Hex } from './storage/signing.js'
import type { ProcessingOutput } from './slots.js'
import { derivedKey } from './keys.js'
import { randomUUID } from 'node:crypto'
import type { FileRecord } from './types.js'

export const SCAN_JOB_KIND = 'data.files:scan'
export const RETENTION_JOB_KIND = 'data.files:retention-sweep'

export interface ScanResult {
  readonly clean: boolean
  readonly scanner: string
  readonly threat?: string
}

export interface ScanRequest {
  readonly fileId: string
  readonly storageKey: string
  readonly contentType: string
  readonly bytes: Uint8Array
}

export interface VirusScanner {
  readonly name: string
  scan(request: ScanRequest): Promise<ScanResult>
}

/**
 * Posts the object to `SCANNER_ENDPOINT` and expects `{ clean: boolean, threat?: string }`.
 * A transport failure is `ScannerUnavailableError`, which the policy below turns into
 * either a retry or a rejection — never into an accessible file.
 */
export class HttpVirusScanner implements VirusScanner {
  readonly name: string
  private readonly endpoint: string
  private readonly fetchImpl: typeof fetch

  constructor(endpoint: string, fetchImpl: typeof fetch = globalThis.fetch) {
    this.endpoint = endpoint
    this.name = `http:${new URL(endpoint).host}`
    this.fetchImpl = fetchImpl
  }

  async scan(request: ScanRequest): Promise<ScanResult> {
    let res: Response
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-forge-file-id': request.fileId,
          'x-forge-content-type': request.contentType,
        },
        body: request.bytes as unknown as BodyInit,
      })
    } catch (cause) {
      throw new ScannerUnavailableError(String(cause))
    }
    if (!res.ok) throw new ScannerUnavailableError(`HTTP ${res.status}`)
    const body = (await res.json()) as { clean?: unknown; threat?: unknown }
    if (typeof body.clean !== 'boolean') {
      throw new ScannerUnavailableError('Scanner response did not include a boolean `clean`.')
    }
    return {
      clean: body.clean,
      scanner: this.name,
      ...(typeof body.threat === 'string' ? { threat: body.threat } : {}),
    }
  }
}

/** The scanner from configuration, else `SCANNER_ENDPOINT`, else none. */
export function resolveScanner(): VirusScanner | null {
  const configured = files().scanner
  if (configured !== undefined) return configured
  const endpoint = process.env['SCANNER_ENDPOINT']
  if (endpoint === undefined || endpoint === '') return null
  return new HttpVirusScanner(endpoint)
}

async function quarantine(fileId: string, reason: string, threat?: string): Promise<void> {
  const repos = await repositories()
  await repos.files.update(fileId, {
    status: 'quarantined',
    scanStatus: threat === undefined ? 'unavailable' : 'infected',
    quarantineReason: reason,
    updatedAt: new Date(),
  })
  await repos.publish('file.quarantined', {
    file_id: fileId,
    reason,
    ...(threat === undefined ? {} : { threat }),
  })
}

async function runPipeline(file: FileRecord, bytes: Uint8Array): Promise<readonly ProcessingOutput[]> {
  const cfg = files()
  const pipeline = cfg.slots.processingPipeline
  if (pipeline === undefined) return []

  const repos = await repositories()
  const outputs = await pipeline({
    file,
    read: async () => bytes,
    write: async (kind, derivedBytes, contentType) => {
      const key = derivedKey(cfg.keyPrefix, file.id, kind, `${kind}.bin`)
      await cfg.storage.put(key, derivedBytes, contentType)
      return key
    },
    enqueue: async (kind, payload) => {
      await repos.enqueue({ kind, payload: { ...payload, fileId: file.id } })
    },
  })

  for (const output of outputs) {
    await repos.thumbnails.create({
      id: randomUUID(),
      fileId: file.id,
      kind: output.kind,
      storageKey: output.storageKey,
      width: output.width ?? null,
      height: output.height ?? null,
      createdAt: new Date(),
    })
  }
  return outputs
}

/**
 * The durable scan job. Idempotent: a file that is not in `scanning` is left alone,
 * so a replay after a crash neither re-publishes `file.uploaded` nor re-runs the
 * client's processing pipeline.
 */
export async function runScanJob(payload: { fileId: string }): Promise<void> {
  const cfg = files()
  const repos = await repositories()

  const file = await repos.files.find(payload.fileId)
  if (file === null) return
  if (file.status !== 'scanning') return

  const bytes = await cfg.storage.get(file.storageKey)
  if (bytes === null) {
    // Storage has not caught up, or the object was removed. Fail so the queue retries
    // rather than marking a file clean we never looked at.
    throw new ScannerUnavailableError(`No object at ${file.storageKey} to scan`)
  }
  const checksum = sha256Hex(bytes)

  let result: ScanResult
  if (cfg.scanPolicy === 'skip') {
    // Local workspaces only — validated in configureFiles.
    result = { clean: true, scanner: 'skipped' }
  } else {
    const scanner = resolveScanner()
    if (scanner === null) {
      if (cfg.scanPolicy === 'reject_when_unavailable') {
        await quarantine(file.id, 'scanner_unavailable')
        return
      }
      throw new ScannerUnavailableError('SCANNER_ENDPOINT is not configured')
    }
    try {
      result = await scanner.scan({
        fileId: file.id,
        storageKey: file.storageKey,
        contentType: file.contentType,
        bytes,
      })
    } catch (err) {
      if (err instanceof ScannerUnavailableError && cfg.scanPolicy === 'reject_when_unavailable') {
        await quarantine(file.id, 'scanner_unavailable')
        return
      }
      // require_clean: propagate so the durable queue retries. The file stays
      // quarantined in the meantime, which is the safe direction to fail.
      throw err
    }
  }

  await repos.publish('file.scanned', {
    file_id: file.id,
    clean: result.clean,
    scanner: result.scanner,
  })

  if (!result.clean) {
    await quarantine(file.id, 'infected', result.threat ?? 'unknown')
    return
  }

  const now = new Date()
  for (const version of await repos.versions.findMany({ fileId: file.id })) {
    if (version.checksum === null) await repos.versions.update(version.id, { checksum })
  }

  const cleanFile: FileRecord = {
    ...file,
    checksum,
    scanStatus: cfg.scanPolicy === 'skip' ? 'skipped' : 'clean',
    scanner: result.scanner,
  }
  const outputs = await runPipeline(cleanFile, bytes)
  if (outputs.length > 0) {
    await repos.publish('file.processed', {
      file_id: file.id,
      pipeline: 'processingPipeline',
      outputs: outputs.map((o) => o.kind),
    })
  }

  await repos.files.update(file.id, {
    checksum,
    scanStatus: cleanFile.scanStatus,
    scanner: result.scanner,
    status: 'available',
    quarantineReason: null,
    updatedAt: now,
  })

  // Published last, and only here: everything downstream may now assume the object
  // exists, is scanned, and is retrievable.
  await repos.publish('file.uploaded', {
    file_id: file.id,
    filename: file.filename,
    content_type: file.contentType,
    size_bytes: file.sizeBytes,
    owner_id: file.ownerId,
    checksum,
  })
}
