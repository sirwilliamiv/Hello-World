/**
 * `exposes: { kind: "route", name: "files", path: "/api/files/*" }`.
 *
 * Web-standard Request/Response so a Next.js App Router route file is three lines:
 *
 *   export { GET, POST, DELETE } from '@forge/data-files'
 *
 * The route is where the 404-not-403 rule is visible: `signedUrl` throws
 * `FileNotAccessibleError`, which carries status 404 and the same code as a genuine
 * miss, so an unscanned object is indistinguishable from one that does not exist.
 */
import { files } from './config.js'
import { requireAccessibleFile, filesFor, filesOwnedBy, signedUrl } from './access.js'
import { deleteFile } from './cascade.js'
import { FilesError } from './errors.js'
import { repositories } from './repositories.js'
import { LocalStorageDriver, LOCAL_OBJECT_PATH } from './storage/local.js'
import { completeUpload, upload } from './uploads.js'
import type { UploadInput } from './types.js'

const ROOT = '/api/files'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function fail(err: unknown): Response {
  if (err instanceof FilesError) {
    return json({ error: err.code, message: err.message }, err.status)
  }
  throw err
}

/**
 * Storage-side handling for the `local` driver: this stands in for what GCS does on
 * its own. It re-checks the signature, the expiry, **and** the file's scan status, so
 * a leaked URL for a file that was later quarantined stops working.
 */
export async function serveLocalObject(request: Request, now: Date = new Date()): Promise<Response> {
  const cfg = files()
  const driver = cfg.storage
  if (!(driver instanceof LocalStorageDriver)) {
    return json({ error: 'not_found' }, 404)
  }
  const params = new URL(request.url).searchParams

  let verified
  try {
    verified = driver.verify(params, now)
  } catch (err) {
    return fail(err)
  }

  const repos = await repositories()
  const [row] = await repos.files.findMany({ storageKey: verified.key })

  if (verified.method === 'PUT') {
    if (row === undefined || row.status !== 'awaiting_upload') return json({ error: 'file_not_found' }, 404)
    const bytes = new Uint8Array(await request.arrayBuffer())
    if (bytes.byteLength > verified.maxSizeBytes) {
      return json({ error: 'upload_rejected', message: 'Object exceeds the signed size limit' }, 413)
    }
    await driver.put(verified.key, bytes, row.contentType)
    return new Response(null, { status: 200 })
  }

  // An object whose file has not cleared scanning is a 404 even with a valid
  // signature. This is the second half of "an unscanned file is never accessible".
  if (row === undefined || row.status !== 'available') return json({ error: 'file_not_found' }, 404)

  const bytes = await driver.get(verified.key)
  if (bytes === null) return json({ error: 'file_not_found' }, 404)

  const filename = params.get('filename') ?? row.filename
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': row.contentType,
      'content-length': String(bytes.byteLength),
      'content-disposition': `inline; filename="${filename.replace(/"/g, '')}"`,
      // A signed URL is a credential. Never let a shared cache keep it.
      'cache-control': 'private, no-store',
    },
  })
}

export async function filesRouteHandler(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const rest = path.startsWith(ROOT) ? path.slice(ROOT.length).replace(/^\//, '') : ''
  const segments = rest === '' ? [] : rest.split('/')

  try {
    if (path.startsWith(LOCAL_OBJECT_PATH)) return await serveLocalObject(request)

    const repos = await repositories()
    const user = await repos.currentUser()

    // Reads of a specific file are authorised by possession of a signed URL; every
    // other route needs a session. `AuthGuard` from kernel.identity wraps this
    // handler in the generated route file for the real permission checks.
    if (request.method !== 'GET' && user === null) {
      return json({ error: 'unauthenticated' }, 401)
    }

    if (request.method === 'POST' && segments.length === 0) {
      const body = (await request.json()) as UploadInput
      return json(await upload(body), 201)
    }

    if (request.method === 'POST' && segments.length === 3 && segments[0] === 'sessions' && segments[2] === 'complete') {
      const file = await completeUpload(segments[1] as string)
      return json({ id: file.id, status: file.status })
    }

    if (request.method === 'GET' && segments.length === 0) {
      if (user === null) return json({ error: 'unauthenticated' }, 401)
      const entity = url.searchParams.get('entity')
      const entityId = url.searchParams.get('id')
      const listed =
        entity !== null && entityId !== null
          ? await filesFor(entity, entityId)
          : await filesOwnedBy(user.id)
      return json(
        listed
          .filter((f) => f.status === 'available')
          .map((f) => ({
            id: f.id,
            filename: f.filename,
            content_type: f.contentType,
            size_bytes: f.sizeBytes,
          })),
      )
    }

    if (request.method === 'GET' && segments.length === 2 && segments[1] === 'url') {
      const id = segments[0] as string
      const ttl = Number(url.searchParams.get('ttl') ?? '')
      const href = await signedUrl(id, Number.isFinite(ttl) && ttl > 0 ? ttl : undefined)
      return json({ url: href })
    }

    if (request.method === 'GET' && segments.length === 1) {
      const id = segments[0] as string
      await requireAccessibleFile(id)
      const href = await signedUrl(id)
      return new Response(null, { status: 302, headers: { location: href } })
    }

    if (request.method === 'DELETE' && segments.length === 1) {
      await deleteFile(segments[0] as string, { cascadeSource: 'api' })
      return new Response(null, { status: 204 })
    }

    return json({ error: 'not_found' }, 404)
  } catch (err) {
    return fail(err)
  }
}

export const GET = filesRouteHandler
export const POST = filesRouteHandler
export const DELETE = filesRouteHandler
