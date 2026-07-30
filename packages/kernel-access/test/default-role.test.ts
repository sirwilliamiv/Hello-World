import {
  configureIdentity,
  register,
  resetIdentityConfig,
  resetIdentityRuntime,
  setIdentityRuntime,
  type User,
} from '@forge/kernel-identity'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { assignDefaultRole, grantRole, revokeRole, rolesFor } from '../src/assignments.js'
import { can } from '../src/can.js'
import {
  configureAccess,
  resetAccessConfig,
  roleDefinitions as roleDefinitionsOf,
} from '../src/config.js'
import { permissions, registerPermission } from '../src/permissions.js'
import { BUILT_IN_ROLES } from '../src/roles.js'
import { resetAccessRuntime, setAccessRuntime } from '../src/runtime.js'
import {
  permissionResolverContext,
  roleDefinitionsContext,
  type PermissionResolverSlot,
  type RoleDefinitionsSlot,
} from '../src/slots.js'
import { createTestRuntime, type TestRuntime } from './support/fakes.js'

/**
 * tests.smoke: "default role on registration" —
 * asserts a newly created user receives the configured default role.
 *
 * Wired exactly as templates/kernel.events/subscriptions.ts.tmpl wires it:
 *
 *   subscribe('identity.user.created', assignDefaultRole)
 */

let runtime: TestRuntime

beforeEach(() => {
  runtime = createTestRuntime()
  // One store backs both capabilities, as one database does in production.
  setAccessRuntime(runtime)
  setIdentityRuntime(runtime)
  resetAccessConfig()
  resetIdentityConfig()
  permissions.clear()
  runtime.subscribe('identity.user.created', assignDefaultRole)
})

afterEach(() => {
  resetAccessRuntime()
  resetIdentityRuntime()
  resetAccessConfig()
  resetIdentityConfig()
  permissions.clear()
})

describe('default role on registration', () => {
  it('assigns the configured default role when identity.user.created arrives', async () => {
    const registered = await register({
      email: 'ada@example.com',
      password: 'correct-horse-battery-staple',
    })

    expect(await rolesFor(registered.user.id)).toEqual(['member'])
    expect(runtime.eventNames()).toContain('access.role.granted')
  })

  it('honours a client-configured default role', async () => {
    configureAccess({ defaultRole: 'viewer' })
    const registered = await register({
      email: 'grace@example.com',
      password: 'correct-horse-battery-staple',
    })
    expect(await rolesFor(registered.user.id)).toEqual(['viewer'])
  })

  it('is idempotent when the event is redelivered', async () => {
    const registered = await register({
      email: 'alan@example.com',
      password: 'correct-horse-battery-staple',
    })
    await assignDefaultRole({
      name: 'identity.user.created',
      payload: { user_id: registered.user.id, email: registered.user.email },
    })

    expect(await rolesFor(registered.user.id)).toEqual(['member'])
    expect(runtime.events.filter((event) => event.name === 'access.role.granted')).toHaveLength(1)
  })

  it('fails loudly on a payload with no user_id rather than silently skipping', async () => {
    await expect(
      assignDefaultRole({ name: 'identity.user.created', payload: { email: 'x@example.com' } }),
    ).rejects.toThrow(/no user_id/)
  })
})

describe('can()', () => {
  function userFixture(id: string): User {
    const at = new Date('2026-07-01T09:00:00.000Z')
    return {
      id,
      email: `${id}@example.com`,
      name: null,
      emailVerifiedAt: at,
      disabledAt: null,
      anonymizedAt: null,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    }
  }

  it('grants everything to owner and nothing by default to anyone else', async () => {
    registerPermission({ action: 'payment.refund', defaultRoles: ['owner'] })
    registerPermission({ action: 'invoice.read', defaultRoles: ['owner', 'admin', 'member'] })

    const owner = userFixture('u_owner')
    const member = userFixture('u_member')
    const nobody = userFixture('u_nobody')
    await grantRole(owner.id, 'owner')
    await grantRole(member.id, 'member')

    expect(await can(owner, 'payment.refund')).toBe(true)
    expect(await can(owner, 'anything.at.all')).toBe(true)

    expect(await can(member, 'invoice.read')).toBe(true)
    expect(await can(member, 'payment.refund')).toBe(false)

    expect(await can(nobody, 'invoice.read')).toBe(false)
  })

  it('lets admin inherit member', async () => {
    registerPermission({ action: 'invoice.read', defaultRoles: ['member'] })
    const admin = userFixture('u_admin')
    await grantRole(admin.id, 'admin')
    expect(await can(admin, 'invoice.read')).toBe(true)
  })

  it('denies a disabled user regardless of role', async () => {
    const owner = { ...userFixture('u_disabled'), disabledAt: new Date() }
    await grantRole(owner.id, 'owner')
    expect(await can(owner, 'payment.refund')).toBe(false)
  })

  it('honours the scope of an assignment', async () => {
    registerPermission({ action: 'invoice.void', defaultRoles: ['owner'] })
    const user = userFixture('u_scoped')
    await grantRole(user.id, 'owner', { scope: 'org_a' })

    expect(await can(user, 'invoice.void', { type: 'Invoice', scope: 'org_a' })).toBe(true)
    expect(await can(user, 'invoice.void', { type: 'Invoice', scope: 'org_b' })).toBe(false)
  })

  it('consults the permissionResolver slot only when no role satisfies the action', async () => {
    const asked: string[] = []
    configureAccess({
      slots: {
        permissionResolver: (ctx) => {
          asked.push(ctx.action)
          return ctx.action === 'report.export' ? true : null
        },
      },
    })
    registerPermission({ action: 'invoice.read', defaultRoles: ['member'] })

    const member = userFixture('u_slot')
    await grantRole(member.id, 'member')

    expect(await can(member, 'invoice.read')).toBe(true)
    expect(asked).toEqual([])

    expect(await can(member, 'report.export')).toBe(true)
    expect(await can(member, 'report.delete')).toBe(false)
    expect(asked).toEqual(['report.export', 'report.delete'])
  })

  it('accepts client roles from the roleDefinitions slot', async () => {
    configureAccess({
      slots: {
        roleDefinitions: (ctx) => [
          ...ctx.proceed(),
          {
            name: 'auditor',
            grants: ['audit.*', 'invoice.read'],
            inherits: ['viewer'],
            rank: 250,
          },
        ],
      },
    })
    const auditor = userFixture('u_auditor')
    await grantRole(auditor.id, 'auditor')

    expect(await can(auditor, 'audit.read')).toBe(true)
    expect(await can(auditor, 'invoice.read')).toBe(true)
    expect(await can(auditor, 'invoice.void')).toBe(false)
  })

  it('stops granting once the role is revoked', async () => {
    registerPermission({ action: 'payment.refund', defaultRoles: ['owner'] })
    const user = userFixture('u_revoked')
    await grantRole(user.id, 'owner')
    expect(await can(user, 'payment.refund')).toBe(true)

    await revokeRole(user.id, 'owner')
    expect(await can(user, 'payment.refund')).toBe(false)
    expect(runtime.eventNames()).toContain('access.role.revoked')
  })
})

describe('the permissions registry', () => {
  it('accepts the bare-string form the generated template renders', () => {
    registerPermission('payment.charge')
    expect(permissions.has('payment.charge')).toBe(true)
    expect(permissions.defaultRolesFor('payment.charge')).toEqual([])
  })

  it('merges rather than narrows on re-registration', () => {
    registerPermission({ action: 'file.read', defaultRoles: ['owner'] })
    registerPermission({ action: 'file.read', defaultRoles: ['admin', 'member'] })
    expect(permissions.defaultRolesFor('file.read')).toEqual(['owner', 'admin', 'member'])
    expect(permissions.actions()).toEqual(['file.read'])
  })
})

/**
 * schemas/capability.schema.json, `$defs.slot.signature`: every slot context
 * exposes `proceed()`, returning what the capability would have done with no
 * slot implemented. internal/render/render.go seeds exactly this body, so the
 * stubs below are the literal generated text.
 */
describe('the proceed() contract', () => {
  function userFixture(id: string): User {
    const at = new Date('2026-07-01T09:00:00.000Z')
    return {
      id,
      email: `${id}@example.com`,
      name: null,
      emailVerifiedAt: at,
      disabledAt: null,
      anonymizedAt: null,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    }
  }

  describe('roleDefinitions', () => {
    it('proceed() returns the built-in owner/admin/member/viewer set', async () => {
      const ctx = roleDefinitionsContext()
      expect(ctx.proceed().map((role) => role.name)).toEqual([
        'owner',
        'admin',
        'member',
        'viewer',
      ])
      expect(ctx.proceed()).toEqual([...BUILT_IN_ROLES])
      // A copy: a client is expected to spread and mutate what it gets back.
      expect(ctx.proceed()).not.toBe(BUILT_IN_ROLES)
      expect(ctx.builtIn).toEqual(BUILT_IN_ROLES)
    })

    it('the seeded stub resolves the same role set as no slot at all', async () => {
      const roleDefinitions: RoleDefinitionsSlot = async (ctx) => {
        return ctx.proceed()
      }
      configureAccess({ slots: { roleDefinitions } })
      expect((await roleDefinitionsOf()).map((role) => role.name)).toEqual([
        'owner',
        'admin',
        'member',
        'viewer',
      ])

      registerPermission({ action: 'invoice.read', defaultRoles: ['member'] })
      const member = userFixture('u_stub_member')
      await grantRole(member.id, 'member')
      expect(await can(member, 'invoice.read')).toBe(true)
      expect(await can(member, 'invoice.void')).toBe(false)
    })

    it('a slot returning something else changes the role set', async () => {
      const roleDefinitions: RoleDefinitionsSlot = async (ctx) => [
        ...ctx.proceed(),
        { name: 'auditor', grants: ['audit.*'], inherits: ['viewer'], rank: 250 },
      ]
      configureAccess({ slots: { roleDefinitions } })
      expect((await roleDefinitionsOf()).map((role) => role.name)).toContain('auditor')

      const auditor = userFixture('u_proceed_auditor')
      await grantRole(auditor.id, 'auditor')
      expect(await can(auditor, 'audit.read')).toBe(true)
    })
  })

  describe('permissionResolver', () => {
    it('proceed() abstains, which leaves the decision at deny', () => {
      const ctx = permissionResolverContext({
        user: userFixture('u_abstain'),
        action: 'report.export',
        resource: undefined,
        roles: ['member'],
        declaration: undefined,
      })
      expect(ctx.proceed()).toBeNull()
    })

    it('the seeded stub decides exactly as no slot at all', async () => {
      const permissionResolver: PermissionResolverSlot = async (ctx) => {
        return ctx.proceed()
      }
      registerPermission({ action: 'invoice.read', defaultRoles: ['member'] })
      const member = userFixture('u_stub_resolver')
      await grantRole(member.id, 'member')

      // Without the slot.
      expect(await can(member, 'invoice.read')).toBe(true)
      expect(await can(member, 'report.export')).toBe(false)

      // With the stub: identical.
      configureAccess({ slots: { permissionResolver } })
      expect(await can(member, 'invoice.read')).toBe(true)
      expect(await can(member, 'report.export')).toBe(false)
    })

    it('a slot returning something else changes the decision', async () => {
      const permissionResolver: PermissionResolverSlot = async (ctx) =>
        ctx.action === 'report.export' ? true : ctx.proceed()
      configureAccess({ slots: { permissionResolver } })

      const member = userFixture('u_override_resolver')
      await grantRole(member.id, 'member')
      expect(await can(member, 'report.export')).toBe(true)
      expect(await can(member, 'report.delete')).toBe(false)
    })
  })
})
