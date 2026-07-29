/**
 * The slot contract: every context exposes `proceed()`, and `proceed()` returns
 * exactly what the generic path resolves with no slot implemented
 * (schemas/capability.schema.json, `$defs.slot.signature`).
 *
 * Each slot is asserted twice — the seeded stub must be indistinguishable from
 * having no slot at all, and a slot that returns something else must change the
 * resolved view. The stub half is what lets Forge seed `src/slots/kernel.admin/`
 * into a client repository before anyone has written a line of it.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { registerAdminEntity, resetAdminEntities } from '../entities.js'
import { setEntitySource } from '../ports/entities.js'
import { bulkActions, entityDisplay, registerBulkAction } from '../registries.js'
import {
  resolveDetailView,
  resolveDisplayConfig,
  resolveFormView,
  resolveListView,
} from '../resolve.js'
import type { AdminSlots, BulkActionSlot, CustomAdminViewSlot, EntityDisplayConfigSlot } from '../slots.js'
import { ALL_ENTITIES, entitySourceFor } from './fixtures.js'

const source = entitySourceFor()

beforeEach(() => {
  resetAdminEntities()
  entityDisplay.clear()
  bulkActions.clear()
  setEntitySource(source)
  for (const descriptor of ALL_ENTITIES) {
    registerAdminEntity({ name: descriptor.name, owner: descriptor.owner })
  }
})

/**
 * Exactly the bodies Forge seeds into `src/slots/kernel.admin/<name>.ts`,
 * `async` included — internal/render/render.go writes every stub as
 * `async (ctx) => { return ctx.proceed() }`, so a slot type that did not accept
 * a promise would break the client's build the moment the stub was seeded.
 */
const seeded: Required<AdminSlots> = {
  customAdminView: (async (ctx) => ctx.proceed()) satisfies CustomAdminViewSlot,
  entityDisplayConfig: (async (ctx) => ctx.proceed()) satisfies EntityDisplayConfigSlot,
  bulkAction: (async (ctx) => ctx.proceed()) satisfies BulkActionSlot,
}

describe('the seeded stubs resolve the generic path unchanged', () => {
  it('resolves every view identically with and without the stubs', async () => {
    entityDisplay.register({ entity: 'Invoice', label: 'Bill', columns: [{ field: 'status' }] })
    registerBulkAction({
      id: 'pay.invoices:void',
      label: 'Void',
      entities: ['Invoice'],
      run: async () => ({ affected: 0 }),
    })

    for (const entity of ALL_ENTITIES.map((e) => e.name)) {
      const bare = await resolveListView(entity, { source })
      const stubbed = await resolveListView(entity, { source, slots: seeded })

      expect(stubbed.columns).toEqual(bare.columns)
      expect(stubbed.label).toBe(bare.label)
      expect(stubbed.bulkActions).toEqual(bare.bulkActions)
      expect(stubbed.custom).toBeNull()
      expect((await resolveDetailView(entity, { source, slots: seeded })).sections).toEqual(
        (await resolveDetailView(entity, { source })).sections,
      )
      expect((await resolveFormView(entity, 'create', { source, slots: seeded })).fields).toEqual(
        (await resolveFormView(entity, 'create', { source })).fields,
      )
    }
  })
})

describe('entityDisplayConfig', () => {
  it('hands the slot the columns the resolver derived, not an empty configuration', async () => {
    const bare = await resolveListView('Invoice', { source })
    let offered: readonly string[] = []

    await resolveListView('Invoice', {
      source,
      slots: {
        entityDisplayConfig: (ctx) => {
          offered = (ctx.proceed().columns ?? []).map((c) => c.field)
          return ctx.proceed()
        },
      },
    })

    expect(offered.length).toBeGreaterThan(0)
    expect(offered).toEqual(bare.columns.map((c) => c.name))
  })

  it('folds capability contributions in before the client sees them', async () => {
    entityDisplay.register({
      entity: 'Invoice',
      label: 'Bill',
      columns: [{ field: 'status', label: 'State' }],
      owner: 'pay.invoices',
    })

    let seen: { label: string | undefined; first: string | undefined } = {
      label: undefined,
      first: undefined,
    }
    await resolveDisplayConfig(source.get('Invoice')!, {
      entityDisplayConfig: (ctx) => {
        seen = { label: ctx.config.label, first: ctx.config.columns?.[0]?.field }
        return ctx.proceed()
      },
    })

    expect(seen).toEqual({ label: 'Bill', first: 'status' })
  })

  it('reorders and drops columns when the slot returns a different list', async () => {
    const view = await resolveListView('Invoice', {
      source,
      slots: {
        entityDisplayConfig: (ctx) => ({
          ...ctx.proceed(),
          columns: [{ field: 'total', label: 'Amount' }, { field: 'number' }],
        }),
      },
    })

    expect(view.columns.map((c) => c.name)).toEqual(['total', 'number'])
    expect(view.columns[0]?.label).toBe('Amount')
  })

  it('gives the client the last word over a capability contribution', async () => {
    entityDisplay.register({ entity: 'Invoice', label: 'Bill', owner: 'pay.invoices' })
    const slots: AdminSlots = {
      entityDisplayConfig: (ctx) =>
        ctx.entity === 'Invoice' ? { ...ctx.proceed(), label: 'Statement' } : ctx.proceed(),
    }
    expect((await resolveListView('Invoice', { source, slots })).label).toBe('Statement')
    expect((await resolveListView('User', { source, slots })).label).toBe('User')
  })
})

describe('bulkAction', () => {
  beforeEach(() => {
    registerBulkAction({
      id: 'pay.invoices:void',
      label: 'Void',
      entities: ['Invoice'],
      run: async () => ({ affected: 0 }),
    })
    registerBulkAction({
      id: 'kernel.admin:delete',
      label: 'Delete',
      entities: '*',
      run: async () => ({ affected: 0 }),
    })
  })

  it('defaults to the actions the registries contributed for that entity', async () => {
    const slots: AdminSlots = { bulkAction: seeded.bulkAction }
    expect((await resolveListView('Invoice', { source, slots })).bulkActions.map((a) => a.id)).toEqual([
      'kernel.admin:delete',
      'pay.invoices:void',
    ])
    expect((await resolveListView('User', { source, slots })).bulkActions.map((a) => a.id)).toEqual([
      'kernel.admin:delete',
    ])
  })

  it('adds, removes and reorders when the slot returns a different list', async () => {
    const custom = {
      id: 'client:remind',
      label: 'Send reminder',
      entities: ['Invoice'] as readonly string[],
      run: async () => ({ affected: 1 }),
    }
    const slots: AdminSlots = {
      bulkAction: (ctx) =>
        ctx.entity === 'Invoice'
          ? [custom, ...ctx.proceed().filter((a) => !a.destructive)]
          : [],
    }

    expect((await resolveListView('Invoice', { source, slots })).bulkActions.map((a) => a.id)).toEqual([
      'client:remind',
      'kernel.admin:delete',
      'pay.invoices:void',
    ])
    expect((await resolveListView('User', { source, slots })).bulkActions).toEqual([])
  })
})

describe('customAdminView', () => {
  it('defaults to no bespoke view, on every entity and every view', async () => {
    const slots: AdminSlots = { customAdminView: seeded.customAdminView }
    for (const entity of ALL_ENTITIES.map((e) => e.name)) {
      expect((await resolveListView(entity, { source, slots })).custom).toBeNull()
      expect((await resolveDetailView(entity, { source, slots })).custom).toBeNull()
      expect((await resolveFormView(entity, 'edit', { source, slots })).custom).toBeNull()
    }
  })

  it('replaces one entity’s view and leaves the generic path resolved underneath', async () => {
    const Custom = () => null
    const slots: AdminSlots = {
      customAdminView: (ctx) =>
        ctx.entity === 'Invoice' && ctx.view === 'list' ? Custom : ctx.proceed(),
    }

    expect((await resolveListView('Invoice', { source, slots })).custom).toBe(Custom)
    expect((await resolveDetailView('Invoice', { source, slots })).custom).toBeNull()
    expect((await resolveListView('User', { source, slots })).custom).toBeNull()
    // Removing the slot restores a working view rather than a blank one.
    expect((await resolveListView('Invoice', { source, slots })).columns.length).toBeGreaterThan(0)
  })
})
