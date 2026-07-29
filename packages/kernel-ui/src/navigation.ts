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
 * The `navigationOrder` slot is applied by the *generated* module before
 * registration (see the template above), not here, so this function is a pure
 * projection of registry state.
 */
export async function resolveNavigation(
  options: ResolveNavigationOptions = {},
): Promise<readonly NavigationEntry[]> {
  const can = options.can ?? permissionResolver
  const entries = navigation
    .all()
    .filter((entry) => options.group === undefined || entry.group === options.group)

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
