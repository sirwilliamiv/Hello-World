import { describe, it, expect, beforeEach } from 'vitest'
import { record, auditTrail, resetAudit, InMemoryAuditStore } from '../src/index.js'
import { recordEntityEvent, recordIdentityEvent } from '../src/index.js'

beforeEach(() => resetAudit())

describe('the activity trail', () => {
  it('records an entity change naming the actor and the entity', async () => {
    await recordEntityEvent({
      name: 'entity.created',
      payload: { entity: 'Invoice', id: 'inv_1', actor: 'user_7', data: {} },
    })
    const [entry] = await auditTrail()
    expect(entry?.action).toBe('entity.created')
    expect(entry?.entity).toBe('Invoice')
    expect(entry?.entityId).toBe('inv_1')
    expect(entry?.actor).toBe('user_7')
  })

  it('tolerates a system action with no actor', async () => {
    await recordEntityEvent({ name: 'entity.deleted', payload: { entity: 'File', id: 'f1', actor: null } })
    const [entry] = await auditTrail()
    expect(entry?.actor).toBeNull()
  })

  it('reads newest first, because a timeline is read backwards', async () => {
    await record({ action: 'first' })
    await record({ action: 'second' })
    await record({ action: 'third' })
    expect((await auditTrail()).map((e) => e.action)).toEqual(['third', 'second', 'first'])
  })

  it('filters to one entity', async () => {
    await record({ action: 'a', entity: 'Invoice', entityId: 'i1' })
    await record({ action: 'b', entity: 'Charge', entityId: 'c1' })
    const trail = await auditTrail({ entity: 'Invoice' })
    expect(trail).toHaveLength(1)
    expect(trail[0]?.entity).toBe('Invoice')
  })

  it('derives ids from the serial so a replay is reproducible', async () => {
    await record({ action: 'x' })
    await record({ action: 'y' })
    const first = (await auditTrail()).map((e) => e.id)
    resetAudit()
    await record({ action: 'x' })
    await record({ action: 'y' })
    expect((await auditTrail()).map((e) => e.id)).toEqual(first)
  })
})

describe('append-only', () => {
  it('rejects re-appending an existing entry at the store layer', async () => {
    const store = new InMemoryAuditStore()
    const entry = {
      id: 'audit-1', occurredAtSerial: 1, actor: null,
      action: 'x', entity: null, entityId: null, summary: 'x',
    }
    await store.append(entry)
    await expect(store.append(entry)).rejects.toThrow(/append-only/)
  })

  it('hands back frozen entries so a reader cannot mutate the trail', async () => {
    await recordIdentityEvent({ name: 'identity.user.created', payload: { user_id: 'u1', email: 'a@b.c' } })
    const [entry] = await auditTrail()
    expect(() => {
      // @ts-expect-error deliberately violating readonly at runtime
      entry.action = 'tampered'
    }).toThrow()
  })
})
