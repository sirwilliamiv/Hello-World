/**
 * Admin routes.
 *
 * One catch-all handler under `/admin`, because the route set is derived from
 * the entity registry and therefore cannot be a fixed file tree — that is the
 * same reason the generated file is 47 lines rather than one route module per
 * entity (§9.1's measurement table).
 *
 * Wire it in the client repository as:
 *
 *   // src/app/admin/[[...segments]]/route.ts
 *   import { createAdminRouteHandlers } from '@forge/kernel-admin'
 *   import { currentUser } from '@forge/kernel-identity'
 *   export const { GET, POST, PATCH, DELETE } =
 *     createAdminRouteHandlers({ getUser: currentUser })
 *
 * Every route calls `guarded(...)` before it touches a repository, so the smoke
 * test "a user without admin.access receives 403 on every admin route" holds by
 * construction rather than by remembering to add a check.
 */

import { ADMIN_ACCESS, ADMIN_EXPORT, type AdminUser } from './ports/access.js'
import { adminEntities, isAdminEntity } from './entities.js'
import { exportResponse } from './export.js'
import {
  AdminForbiddenError,
  AdminNotFoundError,
  guarded,
  notFoundResponse,
} from './guard.js'
import { loadEntitySource, type EntitySource } from './ports/entities.js'
import { repositoryFor, type FindManyOptions, type Row } from './ports/repository.js'
import { bulkActionsFor } from './registries.js'
import {
  resolveDetailView,
  resolveFormView,
  resolveListView,
  type AdminListView,
  type ResolveOptions,
} from './resolve.js'
import type { AdminSlots } from './slots.js'

export type AdminMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export interface AdminRequest {
  readonly method: AdminMethod
  /** Path segments after `/admin`. `[]` is the console index. */
  readonly segments: readonly string[]
  readonly searchParams?: URLSearchParams
  readonly user: AdminUser | null | undefined
  readonly body?: unknown
  readonly slots?: AdminSlots
  /** Defaults to kernel.data's registry, loaded lazily. */
  readonly source?: EntitySource
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function listQuery(view: AdminListView, params: URLSearchParams): FindManyOptions {
  const where: Record<string, unknown> = {}
  for (const filter of view.filters) {
    const value = params.get(filter.field)
    if (value !== null && value !== '') where[filter.field] = value
  }

  const sortField = params.get('sort') ?? view.defaultSort.field
  const direction = params.get('direction') === 'asc' ? 'asc' : view.defaultSort.direction
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1)
  const pageSize = Math.max(
    1,
    Number.parseInt(params.get('pageSize') ?? String(view.pageSize), 10) || view.pageSize,
  )
  const search = params.get('q') ?? ''

  return {
    where,
    ...(search === '' ? {} : { search }),
    orderBy: { field: sortField, direction },
    limit: pageSize,
    offset: (page - 1) * pageSize,
  }
}

/**
 * The whole admin API surface. Returns a `Response` for every input, including
 * refusals — nothing here throws for an expected condition.
 */
export async function handleAdminRequest(request: AdminRequest): Promise<Response> {
  const params = request.searchParams ?? new URLSearchParams()
  const [entityName, second, third] = request.segments
  const source = request.source ?? (await loadEntitySource())
  const options: ResolveOptions = {
    source,
    ...(request.slots === undefined ? {} : { slots: request.slots }),
  }

  // Index: the console itself.
  if (entityName === undefined) {
    if (request.method !== 'GET') return methodNotAllowed()
    return guarded(request.user, ADMIN_ACCESS, async () =>
      json({
        entities: await Promise.all(
          adminEntities().map(async (registration) => {
            const view = await resolveListView(registration.name, options)
            return {
              entity: view.entity,
              owner: view.owner,
              label: view.label,
              pluralLabel: view.pluralLabel,
              path: view.path,
              isClientEntity: view.isClientEntity,
            }
          }),
        ),
      }),
    )
  }

  if (!isAdminEntity(entityName)) {
    // Still gate: whether an entity exists is itself information.
    return guarded(request.user, ADMIN_ACCESS, () =>
      notFoundResponse(`No admin surface for ${entityName}.`),
    )
  }

  // /admin/<Entity>/export
  if (second === 'export' && request.method === 'GET') {
    return guarded(request.user, ADMIN_EXPORT, async () => {
      const view = await resolveListView(entityName, options)
      const repository = await repositoryFor(entityName)
      const result = await repository.findMany({
        ...listQuery(view, params),
        limit: Number.parseInt(params.get('limit') ?? '10000', 10) || 10000,
        offset: 0,
      })
      return exportResponse(view, result.rows)
    })
  }

  // /admin/<Entity>/bulk
  if (second === 'bulk' && request.method === 'POST') {
    return guarded(request.user, ADMIN_ACCESS, async () => {
      const body = (request.body ?? {}) as { action?: string; ids?: readonly string[] }
      const action = bulkActionsFor(entityName).find((a) => a.id === body.action)
      if (action === undefined) {
        throw new AdminNotFoundError(`No bulk action ${String(body.action)} for ${entityName}.`)
      }
      if (action.permission !== undefined) {
        const { requireAdmin } = await import('./guard.js')
        await requireAdmin(request.user, action.permission)
      }
      const user = request.user
      if (user === null || user === undefined) throw new AdminForbiddenError(ADMIN_ACCESS)
      const result = await action.run(body.ids ?? [], { user, entity: entityName })
      return json(result)
    })
  }

  // /admin/<Entity>
  if (second === undefined) {
    if (request.method === 'GET') {
      return guarded(request.user, ADMIN_ACCESS, async () => {
        const view = await resolveListView(entityName, options)
        const repository = await repositoryFor(entityName)
        const result = await repository.findMany(listQuery(view, params))
        return json({
          entity: view.entity,
          columns: view.columns.map((c) => ({
            field: c.name,
            label: c.label,
            numeric: c.numeric,
            sortable: c.sortable,
          })),
          filters: view.filters,
          rows: result.rows,
          total: result.total,
          pageSize: view.pageSize,
        })
      })
    }
    if (request.method === 'POST') {
      return guarded(request.user, ADMIN_ACCESS, async () => {
        const view = await resolveListView(entityName, options)
        if (!view.canCreate) return methodNotAllowed('This entity is append-only.')
        const form = await resolveFormView(entityName, 'create', options)
        const repository = await repositoryFor(entityName)
        const created = await repository.create(pick(request.body, form.fields.map((f) => f.name)))
        return json(created, 201)
      })
    }
    return methodNotAllowed()
  }

  // /admin/<Entity>/<id>
  const id = second
  if (third !== undefined) {
    return guarded(request.user, ADMIN_ACCESS, () =>
      notFoundResponse(`Unknown admin route /admin/${request.segments.join('/')}.`),
    )
  }

  if (request.method === 'GET') {
    return guarded(request.user, ADMIN_ACCESS, async () => {
      const view = await resolveDetailView(entityName, options)
      const repository = await repositoryFor(entityName)
      const row = await repository.find(id)
      if (row === undefined) throw new AdminNotFoundError(`${entityName} ${id} not found.`)
      return json({
        entity: view.entity,
        titleField: view.titleField,
        sections: view.sections.map((section) => ({
          title: section.title,
          fields: section.fields.map((f) => ({ field: f.name, label: f.label, type: f.type })),
        })),
        row,
        canEdit: view.canEdit,
        canDelete: view.canDelete,
      })
    })
  }

  if (request.method === 'PATCH') {
    return guarded(request.user, ADMIN_ACCESS, async () => {
      const view = await resolveDetailView(entityName, options)
      if (!view.canEdit) return methodNotAllowed('This entity is append-only.')
      const form = await resolveFormView(entityName, 'edit', options)
      const repository = await repositoryFor(entityName)
      const updated = await repository.update(
        id,
        pick(request.body, form.fields.map((f) => f.name)),
      )
      return json(updated)
    })
  }

  if (request.method === 'DELETE') {
    return guarded(request.user, ADMIN_ACCESS, async () => {
      const view = await resolveDetailView(entityName, options)
      if (!view.canDelete) return methodNotAllowed('This entity is append-only.')
      const repository = await repositoryFor(entityName)
      await repository.softDelete(id)
      return new Response(null, { status: 204 })
    })
  }

  return methodNotAllowed()
}

function methodNotAllowed(message = 'Method not allowed.'): Response {
  return new Response(JSON.stringify({ error: 'method_not_allowed', message }), {
    status: 405,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * Only fields the resolved form declares are ever written. A payload key that
 * is not an editable field of the entity is dropped rather than passed to the
 * repository — mass assignment is the classic auto-CRUD vulnerability.
 */
function pick(body: unknown, fields: readonly string[]): Row {
  if (typeof body !== 'object' || body === null) return {}
  const source = body as Record<string, unknown>
  const out: Row = {}
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) out[field] = source[field]
  }
  return out
}

export interface AdminRouteHandlerOptions {
  /** Resolves the current user. Usually kernel.identity's session helper. */
  readonly getUser: (request: Request) => Promise<AdminUser | null> | AdminUser | null
  readonly slots?: AdminSlots
  readonly source?: EntitySource
}

type RouteContext = { params: Promise<{ segments?: string[] }> | { segments?: string[] } }

/** Next.js App Router adapters for `src/app/admin/[[...segments]]/route.ts`. */
export function createAdminRouteHandlers(options: AdminRouteHandlerOptions): Record<
  AdminMethod,
  (request: Request, context: RouteContext) => Promise<Response>
> {
  const handler =
    (method: AdminMethod) => async (request: Request, context: RouteContext) => {
      const resolved = await context.params
      const url = new URL(request.url)
      const body =
        method === 'POST' || method === 'PATCH'
          ? await request.json().catch(() => undefined)
          : undefined

      return handleAdminRequest({
        method,
        segments: resolved.segments ?? [],
        searchParams: url.searchParams,
        user: await options.getUser(request),
        ...(body === undefined ? {} : { body }),
        ...(options.slots === undefined ? {} : { slots: options.slots }),
        ...(options.source === undefined ? {} : { source: options.source }),
      })
    }

  return {
    GET: handler('GET'),
    POST: handler('POST'),
    PATCH: handler('PATCH'),
    DELETE: handler('DELETE'),
  }
}
