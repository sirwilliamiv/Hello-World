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
  registerSurface,
  resolveNavigation,
  setNavigationPermissionResolver,
  surfaces,
  type NavigationEntry,
} from '../navigation.js'
import { identityNavigationOrder, type NavigationOrderSlot } from '../slots.js'

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
})

describe('registerNavItem', () => {
  it('accepts the object literal the generated template emits', async () => {
    // templates/kernel.ui/navigation.ts.tmpl renders exactly this shape.
    const items = [
      { label: 'Admin', path: '/admin', group: 'admin', order: 10, permission: 'admin.access' },
      { label: 'Dashboard', path: '/', group: 'main', order: 0 },
    ]
    for (const item of identityNavigationOrder(items)) registerNavItem(item)

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
  it('reorders and hides, because the template registers whatever it returns', async () => {
    const items = [
      { label: 'Admin', path: '/admin', group: 'admin', order: 10 },
      { label: 'Dashboard', path: '/', group: 'main', order: 0 },
      { label: 'Billing', path: '/settings/billing', group: 'settings', order: 20 },
    ]

    // A plausible client slot: promote billing, drop admin.
    const navigationOrder: NavigationOrderSlot = (entries) =>
      entries
        .filter((e) => e.path !== '/admin')
        .map((e) => (e.path === '/settings/billing' ? { ...e, order: -1 } : e))

    for (const item of navigationOrder(items)) registerNavItem(item)

    const visible = await resolveNavigation({ can: () => true })
    expect(visible.map((e) => e.path)).toEqual(['/settings/billing', '/'])
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
