/**
 * The shell navigation.
 *
 * A server component that reads the `navigation` registry. The registry was
 * filled by `src/generated/kernel.ui/navigation.ts`, which the root layout
 * imports for its side effects — so a capability that declared a `surfaces[].nav`
 * block in its spec appears here with no code written by anybody.
 */

import {
  groupNavigation,
  type NavigationEntry,
  type NavigationPermissionResolver,
} from '../navigation.js'
import { resolveNavigation } from '../navigation.js'

export interface NavProps {
  /** Current pathname, for `aria-current`. */
  readonly currentPath?: string
  /** Overrides the installed permission resolver. */
  readonly can?: NavigationPermissionResolver
  /** Human labels for group keys. Unlisted groups are title-cased. */
  readonly groupLabels?: Readonly<Record<string, string>>
}

function titleCase(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1)
}

function isCurrent(currentPath: string | undefined, entry: NavigationEntry): boolean {
  if (currentPath === undefined) return false
  if (currentPath === entry.path) return true
  return entry.path !== '/' && currentPath.startsWith(`${entry.path}/`)
}

export async function Nav({ currentPath, can, groupLabels = {} }: NavProps) {
  const entries = await resolveNavigation(can === undefined ? {} : { can })
  const groups = groupNavigation(entries)

  return (
    <nav className="fui-shell__nav" aria-label="Primary">
      {groups.map(({ group, items }) => (
        <div className="fui-nav__group" key={group}>
          <div className="fui-nav__group-label">{groupLabels[group] ?? titleCase(group)}</div>
          <ul className="fui-nav__list">
            {items.map((entry) => (
              <li key={entry.path}>
                <a
                  className="fui-nav__link"
                  href={entry.path}
                  aria-current={isCurrent(currentPath, entry) ? 'page' : undefined}
                >
                  {entry.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}
