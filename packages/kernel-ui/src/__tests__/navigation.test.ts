/**
 * Spec smoke test: "registered nav entries appear" —
 *   "every capability surface declaring a nav entry is reachable from the
 *    shell".
 *
 * Also exercises the exact call shape the generated
 * src/generated/kernel.ui/navigation.ts produces.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  groupNavigation,
  navigation,
  registerNavItem,
  registerNavItems,
  registerSurface,
  resetNavigationOrder,
  resolveNavigation,
  setNavigationPermissionResolver,
  surfaces,
  type NavigationEntry,
} from '../navigation.js'
import {
  configureUiSlots,
  identityNavigationOrder,
  navigationOrderContext,
  resetUiSlots,
  type NavigationOrderSlot,
} from '../slots.js'

/** The surfaces declared across the Phase 1 kernel specs. */
const KERNEL_SURFACES = [
  { area: 'admin', name: 'Admin', path: '/admin', permission: 'admin.access', nav: { label: 'Admin', group: 'admin', order: 10 } },
  { area: 'app', name: 'Dashboard', path: '/', nav: { label: 'Dashboard', group: 'main', order: 0 } },
  { area: 'app', name: 'Billing', path: '/settings/billing', permission: 'billing.view', nav: { label: 'Billing', group: 'settings', order: 20 } },
] as const

beforeEach(() => {
  navigation.clear()
  surfaces.clear()
  setNavigationPermissionResolver(undefined)
  resetNavigationOrder()
  resetUiSlots()
})

describe('registerNavItem', () => {
  it('accepts the object literal the generated template emits', async () => {
    // templates/kernel.ui/navigation.ts.tmpl renders exactly this shape, in
    // (order, path) order — internal/render/render.go sorts NavItems before
    // emitting them, which is the "declared order" ctx.proceed() returns.
    const items = [
      { label: 'Dashboard', path: '/', group: 'main', order: 0 },
      { label: 'Admin', path: '/admin', group: 'admin', order: 10, permission: 'admin.access' },
    ]
    await registerNavItems(items, identityNavigationOrder)

    expect(navigation.size).toBe(2)
    const visible = await resolveNavigation({ can: () => true })
    expect(visible.map((e) => e.path)).toEqual(['/', '/admin'])
  })

  it('orders by (order, path) — identically to the Go renderer', () => {
    registerNavItem({ label: 'B', path: '/b', group: 'g', order: 5 })
    registerNavItem({ label: 'A', path: '/a', group: 'g', order: 5 })
    registerNavItem({ label: 'Z', path: '/z', group: 'g', order: 1 })

    expect(navigation.all().map((e) => e.path)).toEqual(['/z', '/a', '/b'])
  })

  it('is idempotent on path, so a re-evaluated module does not duplicate', () => {
    const entry: NavigationEntry = { label: 'Admin', path: '/admin', group: 'admin', order: 10 }
    registerNavItem(entry)
    registerNavItem(entry)
    expect(navigation.size).toBe(1)
  })
})

describe('registerSurface', () => {
  it('makes every surface declaring a nav entry reachable from the shell', async () => {
    for (const surface of KERNEL_SURFACES) registerSurface(surface)

    const reachable = new Set((await resolveNavigation({ can: () => true })).map((e) => e.path))
    for (const surface of KERNEL_SURFACES) {
      expect(reachable).toContain(surface.path)
    }
  })

  it('registers the surface itself even without a nav block', () => {
    registerSurface({ area: 'public', name: 'Login', path: '/login' })
    expect(surfaces.get('public:Login')?.name).toBe('Login')
    expect(navigation.size).toBe(0)
  })

  it('carries the surface permission onto the nav entry', () => {
    registerSurface(KERNEL_SURFACES[0])
    expect(navigation.get('/admin')?.permission).toBe('admin.access')
  })
})

describe('permission filtering', () => {
  beforeEach(() => {
    for (const surface of KERNEL_SURFACES) registerSurface(surface)
  })

  it('hides entries the user lacks permission for', async () => {
    const visible = await resolveNavigation({ can: (p) => p !== 'admin.access' })
    expect(visible.map((e) => e.path)).toEqual(['/', '/settings/billing'])
  })

  it('fails closed when no resolver is installed', async () => {
    // kernel.ui requires nothing, so it cannot call can() itself. Until the
    // active access capability installs a resolver, a permissioned entry must
    // not be shown: linking a user to a route that will 403 is worse than
    // omitting the link.
    const visible = await resolveNavigation()
    expect(visible.map((e) => e.path)).toEqual(['/'])
  })

  it('uses the installed resolver when there is one', async () => {
    setNavigationPermissionResolver(async (p) => p === 'admin.access')
    const visible = await resolveNavigation()
    expect(visible.map((e) => e.path)).toEqual(['/', '/admin'])
  })

  it('can be asked to show unresolvable entries, for a preview', async () => {
    const visible = await resolveNavigation({ showUnresolvable: true })
    expect(visible).toHaveLength(3)
  })

  it('filters to one group', async () => {
    const visible = await resolveNavigation({ group: 'admin', can: () => true })
    expect(visible.map((e) => e.path)).toEqual(['/admin'])
  })
})

describe('the navigationOrder slot', () => {
  const DECLARED = [
    { label: 'Dashboard', path: '/', group: 'main', order: 0 },
    { label: 'Admin', path: '/admin', group: 'admin', order: 10 },
    { label: 'Billing', path: '/settings/billing', group: 'settings', order: 20 },
  ]

  it('reorders and hides, because registerNavItems registers whatever it returns', async () => {
    // A plausible client slot: promote billing, drop admin.
    const navigationOrder: NavigationOrderSlot = (ctx) =>
      ctx
        .proceed()
        .filter((e) => e.path !== '/admin')
        .map((e) => (e.path === '/settings/billing' ? { ...e, order: -1 } : e))

    await registerNavItems(DECLARED, navigationOrder)

    const visible = await resolveNavigation({ can: () => true })
    expect(visible.map((e) => e.path)).toEqual(['/settings/billing', '/'])
  })

  /**
   * schemas/capability.schema.json, `$defs.slot.signature`: every slot context
   * exposes proceed(), returning what the capability would have done with no
   * slot implemented. internal/render/render.go seeds exactly this body.
   */
  describe('the proceed() contract', () => {
    it('proceed() returns the entries in their declared order', () => {
      const ctx = navigationOrderContext(DECLARED)
      expect(ctx.proceed().map((e) => e.path)).toEqual(['/', '/admin', '/settings/billing'])
      // A copy: a client is expected to filter and reorder what it gets back.
      expect(ctx.proceed()).not.toBe(DECLARED)
      expect(ctx.entries).toBe(DECLARED)
    })

    it('the seeded stub registers the nav an unslotted product shows', async () => {
      const navigationOrder: NavigationOrderSlot = async (ctx) => {
        return ctx.proceed()
      }
      await registerNavItems(DECLARED, navigationOrder)

      const withStub = (await resolveNavigation({ can: () => true })).map((e) => e.path)
      expect(withStub).toEqual(['/', '/admin', '/settings/billing'])

      // No slot at all agrees.
      navigation.clear()
      resetNavigationOrder()
      await registerNavItems(DECLARED)
      expect((await resolveNavigation({ can: () => true })).map((e) => e.path)).toEqual(withStub)
    })

    it('honours a returned sequence the (order, path) sort would otherwise undo', async () => {
      // Same weight on every entry, and nothing here rewrites `order`: only the
      // sequence differs. Without the slot these sort by path — '/a', '/b',
      // '/c' — so this is the case that proves the return value is respected.
      const flat = [
        { label: 'A', path: '/a', group: 'main', order: 0 },
        { label: 'B', path: '/b', group: 'main', order: 0 },
        { label: 'C', path: '/c', group: 'main', order: 0 },
      ]
      expect((await registerNavItems(flat, identityNavigationOrder)).map((e) => e.path)).toEqual([
        '/a',
        '/b',
        '/c',
      ])
      expect((await resolveNavigation()).map((e) => e.path)).toEqual(['/a', '/b', '/c'])

      navigation.clear()
      resetNavigationOrder()
      const navigationOrder: NavigationOrderSlot = (ctx) => [...ctx.proceed()].reverse()
      await registerNavItems(flat, navigationOrder)
      expect((await resolveNavigation()).map((e) => e.path)).toEqual(['/c', '/b', '/a'])
    })

    it('leaves `order` in charge, so a surface registered later still interleaves', async () => {
      await registerNavItems(DECLARED, (ctx) => [...ctx.proceed()].reverse())
      // kernel.admin and friends register their own surfaces at module eval,
      // after the generated navigation module has run. Weight still decides.
      registerNavItem({ label: 'Reports', path: '/reports', group: 'main', order: 5 })

      expect((await resolveNavigation({ can: () => true })).map((e) => e.path)).toEqual([
        '/',
        '/reports',
        '/admin',
        '/settings/billing',
      ])
    })

    it('is invoked from the slot registry, so a configured slot takes effect', async () => {
      configureUiSlots({ navigationOrder: (ctx) => ctx.proceed().filter((e) => e.path !== '/') })
      await registerNavItems(DECLARED)
      expect((await resolveNavigation({ can: () => true })).map((e) => e.path)).toEqual([
        '/admin',
        '/settings/billing',
      ])
    })
  })
})

describe('groupNavigation', () => {
  it('buckets entries by group, preserving order within a group', () => {
    registerNavItem({ label: 'A', path: '/a', group: 'main', order: 1 })
    registerNavItem({ label: 'B', path: '/b', group: 'admin', order: 2 })
    registerNavItem({ label: 'C', path: '/c', group: 'main', order: 3 })

    const groups = groupNavigation(navigation.all())
    expect(groups.map((g) => g.group)).toEqual(['main', 'admin'])
    expect(groups[0]?.items.map((i) => i.path)).toEqual(['/a', '/c'])
  })
})

describe('registerNavItems and the async slot', () => {
  beforeEach(() => {
    navigation.clear()
    resetNavigationOrder()
    resetUiSlots()
  })

  it('resolveNavigation waits for a registration the caller did not await', async () => {
    // templates/kernel.ui/navigation.ts.tmpl is imported for its side effects by
    // the root layout and cannot use top-level await, so the shell must not be
    // able to render a half-registered nav.
    const slow: NavigationOrderSlot = async (ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return ctx.proceed().filter((e) => e.path !== '/admin')
    }
    void registerNavItems(
      [
        { label: 'Dashboard', path: '/', group: 'main', order: 0 },
        { label: 'Admin', path: '/admin', group: 'admin', order: 10 },
      ],
      slow,
    )

    expect((await resolveNavigation({ can: () => true })).map((e) => e.path)).toEqual(['/'])
  })
})
