/**
 * The `navigation` and `SurfaceRegistration` registries.
 *
 * Spec exposes:
 *   registerNavItem(entry: NavigationEntry): void
 *   registerSurface(surface: SurfaceRegistration): void
 *   registry `navigation` — "ordered by the navigationOrder slot"
 *
 * Call site is generated — templates/kernel.ui/navigation.ts.tmpl:
 *
 *   const items = [
 *     { label: "Admin", path: "/admin", group: "admin", order: 10, permission: "admin.access" },
 *   ]
 *   for (const item of navigationOrder(items)) registerNavItem(item)
 *
 * So `registerNavItem` must accept exactly that object literal, and the
 * `navigationOrder` slot must be typed to take and return an array of them.
 */

import { createRegistry, type Registry } from './registry.js'
import { navigationOrderContext, uiSlots, type NavigationOrderSlot } from './slots.js'

/** The `area` values the capability schema permits for a surface. */
export type SurfaceArea = 'app' | 'admin' | 'public' | 'mobile' | 'email' | 'document'

export interface NavigationEntry {
  readonly label: string
  /** Route path. Also the registry key: two capabilities cannot claim one path. */
  readonly path: string
  readonly group: string
  readonly order: number
  /**
   * Resolved through whichever access capability is active. kernel.ui declares
   * `requires: []`, so it cannot call `can()` itself — see
   * {@link setNavigationPermissionResolver}.
   */
  readonly permission?: string
  /** Optional icon name; the shell does not ship an icon set. */
  readonly icon?: string
  /** Capability id, when the caller knows it. Useful for debugging a fleet. */
  readonly owner?: string
}

export interface SurfaceRegistration {
  readonly area: SurfaceArea
  readonly name: string
  readonly path?: string
  readonly permission?: string
  readonly description?: string
  readonly nav?: { readonly label: string; readonly group?: string; readonly order?: number }
  readonly owner?: string
}

/**
 * Nav entries contributed by capabilities.
 *
 * Sorted by (order, path) — byte-identical to the Go renderer's sort in
 * `BuildGraphFacts`, so what the template emits and what the shell renders
 * agree even when a client's `navigationOrder` slot is the identity function.
 */
export const navigation: Registry<NavigationEntry> = createRegistry<NavigationEntry>({
  name: 'kernel.ui:navigation',
  key: (entry) => entry.path,
  sort: (a, b) => (a.order === b.order ? a.path.localeCompare(b.path) : a.order - b.order),
})

/** Surfaces contributed by capabilities, keyed `area:name`. */
export const surfaces: Registry<SurfaceRegistration> = createRegistry<SurfaceRegistration>({
  name: 'kernel.ui:surfaces',
  key: (surface) => `${surface.area}:${surface.name}`,
  sort: (a, b) => `${a.area}:${a.name}`.localeCompare(`${b.area}:${b.name}`),
})

/** exposes.interface: registerNavItem */
export function registerNavItem(entry: NavigationEntry): void {
  navigation.register(entry)
}

/**
 * The sequence the `navigationOrder` slot last returned, by path.
 *
 * The registry sorts by (order, path) so that registration order cannot make
 * the shell disagree with the Go renderer, which means a slot that reordered
 * entries by returning them in a different sequence would be silently undone.
 * Recording the sequence lets it break ties between entries sharing an `order`
 * — see {@link orderedNavigation}.
 */
let slotOrder: readonly string[] | null = null

/** The in-flight registration `resolveNavigation` waits for. */
let pending: Promise<readonly NavigationEntry[]> | null = null

/**
 * The `navigationOrder` slot's call site: order the graph's nav entries through
 * the slot, register what it returns, and keep that order.
 *
 * This is what templates/kernel.ui/navigation.ts.tmpl drives —
 *
 *     registerNavItems(items, navigationOrder)
 *
 * — passing the entries in the order the resolved graph declared them, which is
 * exactly what `ctx.proceed()` gives back. Returning a subset hides an entry;
 * returning a reordered array reorders one.
 *
 * The seeded stub is `async`, so this has to be too. The generated module is
 * imported for its side effects by the root layout and cannot await, so the
 * returned promise is remembered and `resolveNavigation` waits on it: nothing
 * renders a half-registered nav, and the template needs no top-level await.
 */
export function registerNavItems(
  items: readonly NavigationEntry[],
  slot: NavigationOrderSlot | undefined = uiSlots().navigationOrder,
): Promise<readonly NavigationEntry[]> {
  const registration = (async (): Promise<readonly NavigationEntry[]> => {
    const context = navigationOrderContext(items)
    const ordered = slot === undefined ? context.proceed() : [...(await slot(context))]
    slotOrder = ordered.map((entry) => entry.path)
    for (const entry of ordered) registerNavItem(entry)
    return ordered
  })()
  pending = registration
  return registration
}

/** Forget the slot-imposed order. Test helper; also what a preview needs. */
export function resetNavigationOrder(): void {
  slotOrder = null
  pending = null
}

/**
 * Registry contents in the order the shell shows them.
 *
 * `order` still decides, because it is the weight the resolved graph and the Go
 * renderer both use and an entry registered by `registerSurface` has to
 * interleave with the graph's entries correctly. Within one `order` the
 * sequence the `navigationOrder` slot returned decides, and `path` breaks what
 * is left — so a slot that reorders entries of equal weight is honoured instead
 * of being silently re-sorted, and a slot that wants to move an entry past a
 * different weight changes its `order`.
 */
export function orderedNavigation(): readonly NavigationEntry[] {
  const all = navigation.all()
  if (slotOrder === null) return all
  const rank = new Map(slotOrder.map((path, index) => [path, index]))
  const rankOf = (entry: NavigationEntry): number =>
    rank.get(entry.path) ?? Number.MAX_SAFE_INTEGER
  return [...all].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order
    if (rankOf(a) !== rankOf(b)) return rankOf(a) - rankOf(b)
    return a.path.localeCompare(b.path)
  })
}

/**
 * exposes.interface: registerSurface
 *
 * A surface carrying a `nav` block also registers a navigation entry, which is
 * what makes the spec's `surfaces[].nav` declaration sufficient on its own —
 * the smoke test "registered nav entries appear" depends on this.
 */
export function registerSurface(surface: SurfaceRegistration): void {
  surfaces.register(surface)
  if (surface.nav !== undefined && surface.path !== undefined) {
    registerNavItem({
      label: surface.nav.label,
      path: surface.path,
      group: surface.nav.group ?? surface.area,
      order: surface.nav.order ?? 0,
      ...(surface.permission === undefined ? {} : { permission: surface.permission }),
      ...(surface.owner === undefined ? {} : { owner: surface.owner }),
    })
  }
}

/**
 * How a nav entry's `permission` is checked.
 *
 * kernel.ui declares `requires: []` and therefore may not import
 * `@forge/kernel-access`. The dependency is inverted: whichever access
 * capability is active installs a resolver here. Until one does, entries
 * carrying a permission are hidden — fail closed, because a nav item that
 * links to a route the user will be 403'd from is worse than no nav item.
 */
export type NavigationPermissionResolver = (
  permission: string,
) => boolean | Promise<boolean>

let permissionResolver: NavigationPermissionResolver | undefined

export function setNavigationPermissionResolver(
  resolver: NavigationPermissionResolver | undefined,
): void {
  permissionResolver = resolver
}

export interface ResolveNavigationOptions {
  /** Restrict to one group, e.g. the admin sidebar. */
  readonly group?: string
  /** Override the installed resolver, mostly for tests and previews. */
  readonly can?: NavigationPermissionResolver
  /**
   * Show entries whose permission cannot be evaluated. Default false: an
   * unevaluable permission hides the entry.
   */
  readonly showUnresolvable?: boolean
}

/**
 * The registry, filtered by permission and ordered.
 *
 * The `navigationOrder` slot runs once, at registration, in `registerNavItems`;
 * this is a pure projection of registry state in the order that call left it.
 */
export async function resolveNavigation(
  options: ResolveNavigationOptions = {},
): Promise<readonly NavigationEntry[]> {
  const can = options.can ?? permissionResolver
  // A registration started by the generated module may still be in flight.
  if (pending !== null) await pending
  const entries = orderedNavigation().filter(
    (entry) => options.group === undefined || entry.group === options.group,
  )

  const visible: NavigationEntry[] = []
  for (const entry of entries) {
    if (entry.permission === undefined) {
      visible.push(entry)
      continue
    }
    if (can === undefined) {
      if (options.showUnresolvable === true) visible.push(entry)
      continue
    }
    if (await can(entry.permission)) visible.push(entry)
  }
  return visible
}

/** Nav entries grouped, preserving order within each group. */
export function groupNavigation(
  entries: readonly NavigationEntry[],
): readonly { readonly group: string; readonly items: readonly NavigationEntry[] }[] {
  const groups = new Map<string, NavigationEntry[]>()
  for (const entry of entries) {
    const bucket = groups.get(entry.group)
    if (bucket === undefined) groups.set(entry.group, [entry])
    else bucket.push(entry)
  }
  return [...groups.entries()].map(([group, items]) => ({ group, items }))
}
