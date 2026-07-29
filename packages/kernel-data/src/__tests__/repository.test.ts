/**
 * Smoke test: "optimistic locking rejects a stale write" — plus the other rules
 * the repository exists to enforce, since each of them is a rule that convention
 * alone would not hold: tenant scoping, append-only, soft delete, managed
 * timestamps, the lifecycle events, and the three slots.
 *
 * These run against the in-memory driver, which implements the same port as the
 * Postgres one. The policy under test lives above that port, so what is proven
 * here is what runs in a client's product.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { resetEventBus, subscribe, type EventEnvelope } from '@forge/kernel-events'

import { configureData } from '../db.js'
import { InMemoryDriver } from '../driver.js'
import {
  AppendOnlyViolationError,
  StaleWriteError,
  TenantScopeError,
  ValidationFailedError,
  WriteRejectedError,
} from '../errors.js'
import { clearEntities, registerEntity } from '../registry.js'
import { Repository } from '../repository.js'
import { clearSlots, registerSlots } from '../slots.js'
import { systemContext, type EntityRow } from '../types.js'
import { clearValidationCache } from '../validate.js'

const TENANT_A = '11111111-1111-1111-1111-111111111111'
const TENANT_B = '22222222-2222-2222-2222-222222222222'

let published: EventEnvelope[]
let clock: number
let ids: number

function context(tenantId = TENANT_A) {
  return { tenantId, actor: 'user_1' }
}

beforeEach(() => {
  clock = 0
  ids = 0
  configureData({
    driver: new InMemoryDriver(),
    now: () => new Date(1_700_000_000_000 + clock++ * 1000),
    newId: () => {
      ids += 1
      return `id_${String(ids)}`
    },
    logger: { warn: () => undefined, error: () => undefined },
  })

  clearEntities()
  clearSlots()
  clearValidationCache()

  registerEntity({
    name: 'Invoice',
    owner: 'pay.invoices',
    tenantScoped: true,
    fields: [
      { name: 'number', type: 'string', required: true },
      { name: 'status', type: 'string' },
      { name: 'total', type: 'money' },
    ],
  })
  registerEntity({ name: 'LedgerEntry', owner: 'pay.invoices', tenantScoped: true, appendOnly: true })
  registerEntity({ name: 'Currency', owner: 'kernel.money', tenantScoped: false })

  resetEventBus()
  published = []
  subscribe('**', (event) => {
    published.push(event)
  })
})

describe('optimistic locking', () => {
  it('rejects a write made against a stale revision', async () => {
    const invoices = Repository('Invoice', context())
    const created = await invoices.create({ number: 'INV-1', status: 'draft' })
    expect(created.revision).toBe(1)

    // Two readers see revision 1.
    const readerA = await invoices.findOrFail(created.id)
    const readerB = await invoices.findOrFail(created.id)
    expect(readerA.revision).toBe(1)
    expect(readerB.revision).toBe(1)

    // The first write wins and bumps the revision.
    const updated = await invoices.update(created.id, { status: 'sent' }, readerA.revision)
    expect(updated.revision).toBe(2)
    expect(updated['status']).toBe('sent')

    // The second write is refused, not applied over the top.
    await expect(invoices.update(created.id, { status: 'void' }, readerB.revision)).rejects.toThrow(
      StaleWriteError,
    )

    const current = await invoices.findOrFail(created.id)
    expect(current['status']).toBe('sent')
    expect(current.revision).toBe(2)
  })

  it('names the expected and actual revision in the error', async () => {
    const invoices = Repository('Invoice', context())
    const created = await invoices.create({ number: 'INV-2' })
    await invoices.update(created.id, { status: 'sent' }, 1)

    await expect(invoices.update(created.id, { status: 'void' }, 1)).rejects.toThrow(
      /expected revision 1, found 2/,
    )
  })

  it('increments the revision on soft delete and restore too', async () => {
    const invoices = Repository('Invoice', context())
    const created = await invoices.create({ number: 'INV-3' })

    const deleted = await invoices.softDelete(created.id)
    expect(deleted.revision).toBe(2)

    const restored = await invoices.restore(created.id)
    expect(restored.revision).toBe(3)

    // A caller holding the pre-delete revision cannot restore it.
    await expect(invoices.softDelete(created.id, 1)).rejects.toThrow(StaleWriteError)
  })
})

describe('append-only enforcement', () => {
  it('refuses update, delete and restore at the repository layer', async () => {
    const ledger = Repository('LedgerEntry', context())
    const entry = await ledger.create({ amountMinor: 1000 })

    await expect(ledger.update(entry.id, { amountMinor: 2000 }, 1)).rejects.toThrow(
      AppendOnlyViolationError,
    )
    await expect(ledger.softDelete(entry.id)).rejects.toThrow(AppendOnlyViolationError)
    await expect(ledger.restore(entry.id)).rejects.toThrow(AppendOnlyViolationError)
    await expect(ledger.purge(entry.id)).rejects.toThrow(AppendOnlyViolationError)

    // Corrections are new rows, and reads still work.
    await ledger.create({ amountMinor: -1000 })
    expect(await ledger.count()).toBe(2)
  })
})

describe('tenant scoping', () => {
  it('binds the tenant predicate on every read', async () => {
    const a = Repository('Invoice', context(TENANT_A))
    const b = Repository('Invoice', context(TENANT_B))

    const ofA = await a.create({ number: 'A-1' })
    await b.create({ number: 'B-1' })

    expect((await a.findMany()).map((row) => row['number'])).toEqual(['A-1'])
    expect((await b.findMany()).map((row) => row['number'])).toEqual(['B-1'])

    // Tenant B cannot see, update or delete tenant A's row even knowing its id.
    expect(await b.find(ofA.id)).toBeNull()
    await expect(b.update(ofA.id, { number: 'stolen' }, 1)).rejects.toThrow(/not found/)
  })

  it('refuses to touch a tenant-scoped entity with no tenant in context', async () => {
    const unscoped = Repository('Invoice', { actor: 'user_1' })
    await expect(unscoped.findMany()).rejects.toThrow(TenantScopeError)
    await expect(unscoped.create({ number: 'X-1' })).rejects.toThrow(TenantScopeError)
  })

  it('allows a global entity with no tenant, and a deliberate system context', async () => {
    const currencies = Repository('Currency', {})
    await currencies.create({ code: 'USD' })
    expect(await currencies.count()).toBe(1)

    await Repository('Invoice', context(TENANT_A)).create({ number: 'A-2' })
    await Repository('Invoice', context(TENANT_B)).create({ number: 'B-2' })
    expect(await Repository('Invoice', systemContext()).count()).toBe(2)
  })
})

describe('soft delete and timestamps', () => {
  it('hides soft-deleted rows from reads until they are asked for', async () => {
    const invoices = Repository('Invoice', context())
    const created = await invoices.create({ number: 'INV-4' })

    await invoices.softDelete(created.id)
    expect(await invoices.find(created.id)).toBeNull()
    expect(await invoices.findMany()).toHaveLength(0)

    const deleted = await invoices.findOrFail(created.id, { includeDeleted: true })
    expect(deleted.deletedAt).not.toBeNull()

    await invoices.restore(created.id)
    expect(await invoices.find(created.id)).not.toBeNull()
    expect((await invoices.findOrFail(created.id)).deletedAt).toBeNull()
  })

  it('manages the timestamps and ignores caller-supplied ones', async () => {
    const invoices = Repository('Invoice', context())
    const forged = new Date('1999-01-01T00:00:00.000Z')
    const created = await invoices.create({
      number: 'INV-5',
      createdAt: forged,
      updatedAt: forged,
      revision: 99,
    })

    expect(created.createdAt).not.toEqual(forged)
    expect(created.revision).toBe(1)

    const updated = await invoices.update(created.id, { status: 'sent' }, 1)
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime())
    expect(updated.createdAt.getTime()).toBe(created.createdAt.getTime())
  })
})

describe('lifecycle events', () => {
  it('publishes entity.created / updated / deleted / restored for every entity', async () => {
    const invoices = Repository('Invoice', context())
    const created = await invoices.create({ number: 'INV-6' })
    await invoices.update(created.id, { status: 'sent' }, 1)
    await invoices.softDelete(created.id)
    await invoices.restore(created.id)

    expect(published.map((event) => event.name)).toEqual([
      'entity.created',
      'entity.updated',
      'entity.deleted',
      'entity.restored',
    ])

    for (const event of published) {
      const payload = event.payload as { entity: string; id: string; actor: string | null }
      expect(payload.entity).toBe('Invoice')
      expect(payload.id).toBe(created.id)
      expect(payload.actor).toBe('user_1')
      expect(event.tenantId).toBe(TENANT_A)
    }

    const updatedPayload = published[1]?.payload as { changed: string[]; before: Record<string, unknown> }
    expect(updatedPayload.changed).toContain('status')
    expect(updatedPayload.changed).toContain('revision')
    expect(updatedPayload.before['status']).toBeUndefined()

    const deletedPayload = published[2]?.payload as { soft: boolean }
    expect(deletedPayload.soft).toBe(true)
  })
})

describe('validation and slots', () => {
  it('rejects a float bound to a money field', async () => {
    const invoices = Repository('Invoice', context())
    await expect(
      invoices.create({ number: 'INV-7', total: { amountMinor: 10.5, currency: 'USD' } }),
    ).rejects.toThrow(ValidationFailedError)

    const ok = await invoices.create({
      number: 'INV-8',
      total: { amountMinor: 1050, currency: 'USD' },
    })
    expect(ok['total']).toEqual({ amountMinor: 1050, currency: 'USD' })
  })

  it('requires declared required fields on create but not on update', async () => {
    const invoices = Repository('Invoice', context())
    await expect(invoices.create({ status: 'draft' })).rejects.toThrow(ValidationFailedError)

    const created = await invoices.create({ number: 'INV-9' })
    await expect(invoices.update(created.id, { status: 'sent' }, 1)).resolves.toBeDefined()
  })

  it('runs beforePersist, customValidator and afterPersist', async () => {
    const seen: string[] = []

    registerSlots({
      customValidator: (ctx) => {
        seen.push(`validate:${ctx.operation}`)
        return String(ctx.data['number']).startsWith('BAD')
          ? [{ field: 'number', message: 'reserved prefix' }]
          : []
      },
      beforePersist: (ctx) => {
        seen.push(`before:${ctx.operation}`)
        return ctx.proceed({ ...ctx.data, status: 'stamped' })
      },
      afterPersist: (ctx) => {
        seen.push(`after:${ctx.operation}`)
      },
    })

    const invoices = Repository('Invoice', context())
    const created = await invoices.create({ number: 'INV-10' })

    expect(created['status']).toBe('stamped')
    expect(seen).toEqual(['validate:create', 'before:create', 'after:create'])
    await expect(invoices.create({ number: 'BAD-1' })).rejects.toThrow(/reserved prefix/)
  })

  it('lets a beforePersist slot refuse a write', async () => {
    registerSlots({ beforePersist: (ctx) => ctx.reject('not on my watch') })
    const invoices = Repository('Invoice', context())
    await expect(invoices.create({ number: 'INV-11' })).rejects.toThrow(WriteRejectedError)
    expect(await invoices.count()).toBe(0)
  })

  it('rolls the write back when an afterPersist slot throws', async () => {
    registerSlots({
      afterPersist: () => {
        throw new Error('side effect failed')
      },
    })
    const invoices = Repository('Invoice', context())
    await expect(invoices.create({ number: 'INV-12' })).rejects.toThrow('side effect failed')
    expect(await invoices.count()).toBe(0)
  })
})

describe('typed rows', () => {
  interface Invoice extends EntityRow {
    number: string
    status: string
  }

  it('carries the caller-supplied row type through', async () => {
    const invoices = Repository<Invoice>('Invoice', context())
    const created = await invoices.create({ number: 'INV-13', status: 'draft' })
    expect(created.number).toBe('INV-13')
  })
})
