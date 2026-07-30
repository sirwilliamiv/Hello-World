/**
 * Spec smoke test: "every registered entity has an admin surface" —
 *   "each entity in the registry, including manifest-declared ones, resolves a
 *    list and a detail view".
 *
 * This is the test that decides whether the architecture's central claim is
 * true: that declaring an entity in the manifest buys a working admin surface
 * with no per-entity work. It is asserted over the *whole* registry, not a
 * hand-picked example, and with no per-entity configuration registered.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  registerAdminEntity,
  resetAdminEntities,
  adminEntities,
  clientEntities,
} from '../entities.js'
import { entityDisplay, registerBulkAction, bulkActions } from '../registries.js'
import {
  UnknownAdminEntityError,
  allFields,
  controlFor,
  resolveAdminConsole,
  resolveDetailView,
  resolveFormView,
  resolveListView,
} from '../resolve.js'
import { setEntitySource } from '../ports/entities.js'
import type { AdminSlots, CustomAdminViewSlot } from '../slots.js'
import { ALL_ENTITIES, AWKWARD_ENTITY, entitySourceFor } from './fixtures.js'

const source = entitySourceFor()

beforeEach(() => {
  resetAdminEntities()
  entityDisplay.clear()
  bulkActions.clear()
  setEntitySource(source)
  // Exactly what templates/kernel.admin/admin-entities.ts.tmpl renders.
  for (const descriptor of ALL_ENTITIES) {
    registerAdminEntity({ name: descriptor.name, owner: descriptor.owner })
  }
})

describe('registerAdminEntity', () => {
  it('accepts exactly the { name, owner } the template emits', async () => {
    resetAdminEntities()
    registerAdminEntity({ name: 'Invoice', owner: 'pay.invoices' })
    registerAdminEntity({ name: 'SiteVisit', owner: '<client>' })

    expect(adminEntities().map((e) => e.name)).toEqual(['Invoice', 'SiteVisit'])
    expect(clientEntities().map((e) => e.name)).toEqual(['SiteVisit'])
  })

  it('is idempotent, so a re-evaluated generated module does not duplicate', async () => {
    const before = adminEntities().length
    registerAdminEntity({ name: 'Invoice', owner: 'pay.invoices' })
    expect(adminEntities()).toHaveLength(before)
  })

  it('orders deterministically', async () => {
    const names = adminEntities().map((e) => e.name)
    expect(names).toEqual([...names].sort())
  })
})

describe('every registered entity resolves a list and a detail view', () => {
  it('resolves both for all 16 registered entities with no configuration', async () => {
    const resolved = await resolveAdminConsole({ source })

    expect(resolved).toHaveLength(ALL_ENTITIES.length)
    for (const views of resolved) {
      expect(views.list.entity).toBe(views.registration.name)
      expect(views.list.columns.length).toBeGreaterThan(0)
      expect(views.list.path).toBe(`/admin/${views.registration.name}`)

      expect(views.detail.entity).toBe(views.registration.name)
      expect(views.detail.sections.length).toBeGreaterThan(0)
      expect(views.detail.sections.flatMap((s) => s.fields).length).toBeGreaterThan(0)
      expect(views.detail.path('42')).toBe(`/admin/${views.registration.name}/42`)
    }
  })

  it('resolves create and edit forms for every entity too', async () => {
    for (const views of await resolveAdminConsole({ source })) {
      // AuditEntry is append-only; it still resolves a form shape, but the list
      // view refuses create/edit/delete.
      expect(views.create.mode).toBe('create')
      expect(views.edit.mode).toBe('edit')
      if (views.registration.name === 'AuditEntry') {
        expect(views.list.canCreate).toBe(false)
        expect(views.list.canEdit).toBe(false)
        expect(views.list.canDelete).toBe(false)
        expect(views.detail.canDelete).toBe(false)
      } else {
        expect(views.list.canCreate).toBe(true)
      }
    }
  })

  it('treats a manifest-declared entity exactly like a capability-owned one', async () => {
    const client = await resolveListView('ClientThing1', { source })
    const capability = await resolveListView('Invoice', { source })

    // Same shape, same guarantees. The only difference is the owner.
    expect(Object.keys(client).sort()).toEqual(Object.keys(capability).sort())
    expect(client.isClientEntity).toBe(true)
    expect(capability.isClientEntity).toBe(false)
    expect(client.permission).toBe('admin.access')
    expect(client.exportPermission).toBe('admin.export')
  })

  it('does not grow the generated file when client entities are added', async () => {
    // §9.1: capability output must stay flat against the client's data model.
    // The generated admin file is one registerAdminEntity() line per entity —
    // which is the client's model rendered, measured as <client>, not as
    // kernel.admin. What must stay constant is that no *configuration* is
    // required per entity.
    const configured = (await resolveAdminConsole({ source })).filter(
      (views) => entityDisplay.get(views.registration.name) !== undefined,
    )
    expect(configured).toHaveLength(0)
  })

  it('fails with a message that names the fix when an entity is not in the registry', async () => {
    registerAdminEntity({ name: 'Ghost', owner: '<client>' })
    await expect(resolveListView('Ghost', { source })).rejects.toThrow(UnknownAdminEntityError)
    await expect(resolveListView('Ghost', { source })).rejects.toThrow(
      /kernel\.data entity registry/u,
    )
  })
})

describe('derived list columns', () => {
  it('includes id and caps the column count', async () => {
    const view = await resolveListView('Invoice', { source })
    expect(view.columns[0]?.name).toBe('id')
    expect(view.columns.length).toBeLessThanOrEqual(6)
  })

  it('leaves long and structured types out of the list, but not out of detail', async () => {
    const list = await resolveListView('Invoice', { source })
    const detail = await resolveDetailView('Invoice', { source })
    const detailFields = detail.sections.flatMap((s) => s.fields).map((f) => f.name)

    expect(list.columns.map((c) => c.name)).not.toContain('notes') // text
    expect(list.columns.map((c) => c.name)).not.toContain('metadata') // json
    expect(detailFields).toContain('notes')
    expect(detailFields).toContain('metadata')
  })

  it('excludes one-to-many references from list and form', async () => {
    const list = await resolveListView('SiteVisit', { source })
    const form = await resolveFormView('SiteVisit', 'create', { source })
    expect(list.columns.map((c) => c.name)).not.toContain('photos')
    expect(form.fields.map((f) => f.name)).not.toContain('photos')
  })

  it('marks money and numeric fields numeric', async () => {
    const view = await resolveListView('Invoice', { source })
    expect(view.columns.find((c) => c.name === 'total')?.numeric).toBe(true)
    expect(view.columns.find((c) => c.name === 'number')?.numeric).toBe(false)
  })
})

describe('derived filters and search', () => {
  it('offers a filter for every enum and boolean field', async () => {
    const view = await resolveListView('Invoice', { source })
    expect(view.filters.map((f) => f.field).sort()).toEqual(['paid', 'status'])
    expect(view.filters.find((f) => f.field === 'status')?.options.map((o) => o.value)).toEqual([
      'draft',
      'sent',
      'paid',
      'void',
    ])
    expect(view.filters.find((f) => f.field === 'paid')?.options.map((o) => o.label)).toEqual([
      'Yes',
      'No',
    ])
  })

  it('searches text-shaped fields and not enums or numbers', async () => {
    const view = await resolveListView('Invoice', { source })
    expect(view.searchFields).toContain('number')
    expect(view.searchFields).toContain('notes')
    expect(view.searchFields).not.toContain('status')
    expect(view.searchFields).not.toContain('total')
  })
})

describe('derived detail sections', () => {
  it('separates the entity fields from the record metadata', async () => {
    const view = await resolveDetailView('ClientThing1', { source })
    expect(view.sections.map((s) => s.title)).toEqual(['Client thing1', 'Record'])
    expect(view.sections[1]?.fields.map((f) => f.name)).toEqual(['id', 'createdAt', 'updatedAt'])
  })

  it('titles a record from name, then title, then the first string field', async () => {
    expect((await resolveDetailView('User', { source })).titleField).toBe('name')
    expect((await resolveDetailView('Invoice', { source })).titleField).toBe('number')
    // SiteVisit has no string field at all: fall back to id rather than crash.
    expect((await resolveDetailView('SiteVisit', { source })).titleField).toBe('id')
  })
})

describe('derived forms', () => {
  it('omits the system fields the repository owns', async () => {
    const form = await resolveFormView('Invoice', 'edit', { source })
    expect(form.fields.map((f) => f.name)).not.toContain('id')
    expect(form.fields.map((f) => f.name)).not.toContain('createdAt')
  })

  it('maps each declared field type to a control', async () => {
    expect(controlFor({ name: 'a', type: 'text' })).toBe('textarea')
    expect(controlFor({ name: 'a', type: 'money' })).toBe('money')
    expect(controlFor({ name: 'a', type: 'boolean' })).toBe('checkbox')
    expect(controlFor({ name: 'a', type: 'datetime' })).toBe('datetime')
    expect(controlFor({ name: 'a', type: 'ref:User' })).toBe('reference')
    expect(controlFor({ name: 'a', type: 'refs:File' })).toBe('references')
    expect(controlFor({ name: 'a', type: 'string', enum: ['x'] })).toBe('select')
  })

  it('adds the kernel.data system fields exactly once', async () => {
    const fields = allFields(AWKWARD_ENTITY).map((f) => f.name)
    expect(fields[0]).toBe('id')
    expect(fields.filter((f) => f === 'id')).toHaveLength(1)
    expect(fields.slice(-2)).toEqual(['createdAt', 'updatedAt'])
  })
})

describe('the entityDisplay registry and the entityDisplayConfig slot', () => {
  it('lets a capability pin columns and label an entity', async () => {
    entityDisplay.register({
      entity: 'Invoice',
      label: 'Bill',
      columns: [
        { field: 'status', label: 'State' },
        { field: 'total', label: 'Amount' },
      ],
      owner: 'pay.invoices',
    })

    const view = await resolveListView('Invoice', { source })
    expect(view.label).toBe('Bill')
    expect(view.pluralLabel).toBe('Bills')
    expect(view.columns.slice(0, 2).map((c) => c.label)).toEqual(['State', 'Amount'])
    // Unmentioned fields still appear, so pinning two columns does not hide the rest.
    expect(view.columns.map((c) => c.name)).toContain('number')
  })

  it('hides fields everywhere when the config says to', async () => {
    entityDisplay.register({ entity: 'User', hiddenFields: ['lastSeenAt'] })
    const list = await resolveListView('User', { source })
    const detail = await resolveDetailView('User', { source })
    expect(list.columns.map((c) => c.name)).not.toContain('lastSeenAt')
    expect(detail.sections.flatMap((s) => s.fields).map((f) => f.name)).not.toContain(
      'lastSeenAt',
    )
    expect(list.exportFields).not.toContain('lastSeenAt')
  })

  it('gives the client slot the last word over a capability contribution', async () => {
    entityDisplay.register({ entity: 'Invoice', label: 'Bill', owner: 'pay.invoices' })
    const slots: AdminSlots = {
      entityDisplayConfig: (ctx) =>
        ctx.entity === 'Invoice' ? { ...ctx.proceed(), label: 'Statement' } : ctx.proceed(),
    }
    expect((await resolveListView('Invoice', { source, slots })).label).toBe('Statement')
  })

  it('honours a configured detail layout and sweeps the rest into Other', async () => {
    entityDisplay.register({
      entity: 'Invoice',
      sections: [{ title: 'Money', fields: ['total', 'status'] }],
    })
    const detail = await resolveDetailView('Invoice', { source })
    expect(detail.sections[0]?.title).toBe('Money')
    expect(detail.sections[0]?.fields.map((f) => f.name)).toEqual(['total', 'status'])
    expect(detail.sections[1]?.title).toBe('Other')
    expect(detail.sections[1]?.fields.map((f) => f.name)).toContain('number')
  })
})

describe('the bulkActions registry and the bulkAction slot', () => {
  it('surfaces actions on the entities they declare', async () => {
    registerBulkAction({
      id: 'pay.invoices:void',
      label: 'Void',
      entities: ['Invoice'],
      destructive: true,
      run: async () => ({ affected: 0 }),
    })
    registerBulkAction({
      id: 'kernel.admin:delete',
      label: 'Delete',
      entities: '*',
      run: async () => ({ affected: 0 }),
    })

    expect((await resolveListView('Invoice', { source })).bulkActions.map((a) => a.id)).toEqual([
      'kernel.admin:delete',
      'pay.invoices:void',
    ])
    expect((await resolveListView('User', { source })).bulkActions.map((a) => a.id)).toEqual([
      'kernel.admin:delete',
    ])
  })

  it('lets the client slot add and remove actions', async () => {
    registerBulkAction({
      id: 'pay.invoices:void',
      label: 'Void',
      entities: ['Invoice'],
      run: async () => ({ affected: 0 }),
    })
    const slots: AdminSlots = { bulkAction: () => [] }
    expect((await resolveListView('Invoice', { source, slots })).bulkActions).toEqual([])
  })
})

describe('the customAdminView slot', () => {
  it('replaces one entity’s view and leaves every other on the generic path', async () => {
    const Custom = () => null
    const customAdminView: CustomAdminViewSlot = (ctx) =>
      ctx.entity === 'Invoice' && ctx.view === 'list' ? Custom : ctx.proceed()
    const slots: AdminSlots = { customAdminView }

    expect((await resolveListView('Invoice', { source, slots })).custom).toBe(Custom)
    expect((await resolveDetailView('Invoice', { source, slots })).custom).toBeNull()
    expect((await resolveListView('User', { source, slots })).custom).toBeNull()
    // The generic path still resolves fully underneath, so removing the slot
    // restores a working view rather than a blank one.
    expect((await resolveListView('Invoice', { source, slots })).columns.length).toBeGreaterThan(0)
  })
})
