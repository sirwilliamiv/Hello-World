/**
 * Spec smoke test: "admin is permission-gated" —
 *   "a user without admin.access receives 403 on every admin route".
 *
 * "Every route" is taken literally: the assertion enumerates the full route
 * surface for every registered entity, so a route added later without a guard
 * fails here rather than in a client's production environment.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { registerAdminEntity, resetAdminEntities } from '../entities.js'
import { AdminForbiddenError, guarded, mayAdmin, requireAdmin } from '../guard.js'
import { ADMIN_ACCESS, ADMIN_EXPORT, setPermissionChecker } from '../ports/access.js'
import { setEntitySource } from '../ports/entities.js'
import { setRepositoryFactory } from '../ports/repository.js'
import { bulkActions, entityDisplay, registerBulkAction } from '../registries.js'
import { handleAdminRequest, type AdminMethod } from '../routes.js'
import { ALL_ENTITIES, entitySourceFor, memoryRepository } from './fixtures.js'

const source = entitySourceFor()
const user = { id: 'user-1' }

/** Every route shape the admin surface serves, per entity. */
function routesFor(entity: string): readonly { method: AdminMethod; segments: string[] }[] {
  return [
    { method: 'GET', segments: [] },
    { method: 'GET', segments: [entity] },
    { method: 'POST', segments: [entity] },
    { method: 'GET', segments: [entity, 'export'] },
    { method: 'POST', segments: [entity, 'bulk'] },
    { method: 'GET', segments: [entity, '1'] },
    { method: 'PATCH', segments: [entity, '1'] },
    { method: 'DELETE', segments: [entity, '1'] },
    { method: 'GET', segments: [entity, '1', 'anything'] },
    { method: 'GET', segments: ['NoSuchEntity'] },
  ]
}

beforeEach(() => {
  resetAdminEntities()
  entityDisplay.clear()
  bulkActions.clear()
  setEntitySource(source)
  setPermissionChecker(undefined)
  setRepositoryFactory(() => memoryRepository([{ id: '1', name: 'Row one', status: 'draft' }]))
  for (const descriptor of ALL_ENTITIES) {
    registerAdminEntity({ name: descriptor.name, owner: descriptor.owner })
  }
})

describe('403 without admin.access', () => {
  it('refuses every route for every registered entity', async () => {
    setPermissionChecker(() => false)

    for (const descriptor of ALL_ENTITIES) {
      for (const route of routesFor(descriptor.name)) {
        const response = await handleAdminRequest({
          method: route.method,
          segments: route.segments,
          user,
          source,
          body: { action: 'kernel.admin:delete', ids: ['1'] },
        })
        expect(
          response.status,
          `${route.method} /admin/${route.segments.join('/')}`,
        ).toBe(403)
        expect(await response.clone().json()).toMatchObject({
          error: 'forbidden',
          action: expect.any(String) as unknown as string,
        })
      }
    }
  })

  it('refuses an anonymous visitor', async () => {
    // No checker installed and no user: `can()` denies before it even tries to
    // load kernel.access.
    for (const route of routesFor('Invoice')) {
      const response = await handleAdminRequest({
        method: route.method,
        segments: route.segments,
        user: null,
        source,
      })
      expect(response.status).toBe(403)
    }
  })

  it('refuses when the access capability cannot be resolved at all', async () => {
    // Denying is the only safe default: an admin console that opens because its
    // permission layer failed to load is a breach, not a degraded experience.
    setPermissionChecker(undefined)
    const response = await handleAdminRequest({
      method: 'GET',
      segments: ['Invoice'],
      user,
      source,
    })
    expect(response.status).toBe(403)
  })

  it('does not leak whether an entity exists', async () => {
    setPermissionChecker(() => false)
    const known = await handleAdminRequest({ method: 'GET', segments: ['Invoice'], user, source })
    const unknown = await handleAdminRequest({
      method: 'GET',
      segments: ['NoSuchEntity'],
      user,
      source,
    })
    expect(known.status).toBe(403)
    expect(unknown.status).toBe(403)
  })
})

describe('with admin.access', () => {
  beforeEach(() => {
    setPermissionChecker((_user, action) => action === ADMIN_ACCESS)
  })

  it('serves the console index', async () => {
    const response = await handleAdminRequest({ method: 'GET', segments: [], user, source })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { entities: { entity: string }[] }
    expect(body.entities).toHaveLength(ALL_ENTITIES.length)
  })

  it('serves a list and a detail view', async () => {
    const list = await handleAdminRequest({ method: 'GET', segments: ['Invoice'], user, source })
    expect(list.status).toBe(200)
    expect((await list.json()) as { total: number }).toMatchObject({ total: 1 })

    const detail = await handleAdminRequest({
      method: 'GET',
      segments: ['Invoice', '1'],
      user,
      source,
    })
    expect(detail.status).toBe(200)
  })

  it('404s a missing record without revealing anything else', async () => {
    const response = await handleAdminRequest({
      method: 'GET',
      segments: ['Invoice', '999'],
      user,
      source,
    })
    expect(response.status).toBe(404)
  })

  it('still refuses export, which needs the separate admin.export permission', async () => {
    const response = await handleAdminRequest({
      method: 'GET',
      segments: ['Invoice', 'export'],
      user,
      source,
    })
    expect(response.status).toBe(403)
    expect((await response.json()) as { action: string }).toMatchObject({
      action: ADMIN_EXPORT,
    })
  })

  it('refuses to create or edit an append-only entity', async () => {
    const created = await handleAdminRequest({
      method: 'POST',
      segments: ['AuditEntry'],
      user,
      source,
      body: { action: 'x' },
    })
    expect(created.status).toBe(405)

    const deleted = await handleAdminRequest({
      method: 'DELETE',
      segments: ['AuditEntry', '1'],
      user,
      source,
    })
    expect(deleted.status).toBe(405)
  })

  it('drops payload keys that are not editable fields', async () => {
    const repository = memoryRepository()
    setRepositoryFactory(() => repository)

    const response = await handleAdminRequest({
      method: 'POST',
      segments: ['ClientThing1'],
      user,
      source,
      body: { name: 'Legitimate', id: 'forged', createdAt: 'forged', bogus: true },
    })

    expect(response.status).toBe(201)
    const created = repository.rows[0]!
    expect(created['name']).toBe('Legitimate')
    // Mass assignment is the classic auto-CRUD hole; only declared editable
    // fields reach the repository.
    expect(created['id']).not.toBe('forged')
    expect(created['createdAt']).toBeUndefined()
    expect(created['bogus']).toBeUndefined()
  })

  it('gates a bulk action on its own extra permission', async () => {
    let ran = false
    registerBulkAction({
      id: 'pay.invoices:void',
      label: 'Void',
      entities: ['Invoice'],
      permission: 'invoices.void',
      run: async () => {
        ran = true
        return { affected: 1 }
      },
    })

    const response = await handleAdminRequest({
      method: 'POST',
      segments: ['Invoice', 'bulk'],
      user,
      source,
      body: { action: 'pay.invoices:void', ids: ['1'] },
    })

    expect(response.status).toBe(403)
    expect(ran).toBe(false)
  })

  it('runs a bulk action the user is permitted', async () => {
    setPermissionChecker(() => true)
    registerBulkAction({
      id: 'pay.invoices:void',
      label: 'Void',
      entities: ['Invoice'],
      run: async (ids) => ({ affected: ids.length }),
    })

    const response = await handleAdminRequest({
      method: 'POST',
      segments: ['Invoice', 'bulk'],
      user,
      source,
      body: { action: 'pay.invoices:void', ids: ['1', '2'] },
    })

    expect(response.status).toBe(200)
    expect((await response.json()) as { affected: number }).toMatchObject({ affected: 2 })
  })
})

describe('with admin.export', () => {
  it('exports CSV of the declared export fields', async () => {
    setPermissionChecker(() => true)
    setRepositoryFactory(() =>
      memoryRepository([
        { id: '1', number: 'INV-1', total: 1250, status: 'paid', notes: 'a, "quoted" note' },
      ]),
    )

    const response = await handleAdminRequest({
      method: 'GET',
      segments: ['Invoice', 'export'],
      user,
      source,
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/csv')
    expect(response.headers.get('content-disposition')).toContain('Invoice.csv')

    const csv = await response.text()
    expect(csv.split('\r\n')[0]).toBe(
      'id,number,customer,total,status,notes,metadata,issuedOn,paid,createdAt,updatedAt',
    )
    expect(csv).toContain('"a, ""quoted"" note"')
  })
})

describe('guard helpers', () => {
  it('requireAdmin throws AdminForbiddenError naming the action', async () => {
    setPermissionChecker(() => false)
    await expect(requireAdmin(user, ADMIN_ACCESS)).rejects.toBeInstanceOf(AdminForbiddenError)
    await expect(requireAdmin(user, ADMIN_ACCESS)).rejects.toMatchObject({
      action: ADMIN_ACCESS,
      status: 403,
    })
  })

  it('mayAdmin answers without throwing, for hiding rather than refusing', async () => {
    setPermissionChecker((_u, action) => action === ADMIN_ACCESS)
    expect(await mayAdmin(user)).toBe(true)
    expect(await mayAdmin(user, ADMIN_EXPORT)).toBe(false)
    expect(await mayAdmin(null)).toBe(false)
  })

  it('guarded turns a refusal inside the handler into a 403 too', async () => {
    setPermissionChecker(() => true)
    const response = await guarded(user, ADMIN_ACCESS, () => {
      throw new AdminForbiddenError('something.else')
    })
    expect(response.status).toBe(403)
    expect((await response.json()) as { action: string }).toMatchObject({
      action: 'something.else',
    })
  })

  it('passes a row-level resource through to can()', async () => {
    const seen: unknown[] = []
    setPermissionChecker((_u, action, resource) => {
      seen.push({ action, resource })
      return true
    })
    await requireAdmin(user, ADMIN_ACCESS, { type: 'Invoice', id: '1' })
    expect(seen).toEqual([
      { action: ADMIN_ACCESS, resource: { type: 'Invoice', id: '1' } },
    ])
  })
})
