import type { RoleDefinition, RoleName } from './types.js'

/**
 * Owner, admin, member, viewer — the four roles kernel.access ships.
 *
 * Only `owner` carries a blanket grant. The catalog shows why nothing else can:
 * `queue.read` is owner/admin while `file.read` is owner/admin/member, so no
 * rule derived from the action string alone reproduces the intended grants.
 * Everything below owner is granted either by a permission's declared
 * `default_roles` or by a client's `roleDefinitions` slot.
 */
export const BUILT_IN_ROLES: readonly RoleDefinition[] = [
  {
    name: 'owner',
    description: 'Full control, including destructive and financial actions.',
    grants: ['*'],
    rank: 400,
  },
  {
    name: 'admin',
    description: 'Day-to-day administration. Inherits everything a member can do.',
    grants: [],
    inherits: ['member'],
    rank: 300,
  },
  {
    name: 'member',
    description: 'The default role. Inherits everything a viewer can do.',
    grants: [],
    inherits: ['viewer'],
    rank: 200,
  },
  {
    name: 'viewer',
    description: 'Read-only participation.',
    grants: [],
    rank: 100,
  },
]

/** Match an action against a grant pattern: exact, prefix glob, or `*`. */
export function grantMatches(pattern: string, action: string): boolean {
  if (pattern === '*' || pattern === action) return true
  if (!pattern.includes('*')) return false
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(action)
}

/** Resolve a role name to itself plus everything it inherits, transitively. */
export function expandRole(
  name: RoleName,
  definitions: readonly RoleDefinition[],
  seen = new Set<RoleName>(),
): RoleDefinition[] {
  if (seen.has(name)) return []
  seen.add(name)
  const definition = definitions.find((candidate) => candidate.name === name)
  if (definition === undefined) return []
  const inherited = (definition.inherits ?? []).flatMap((parent) =>
    expandRole(parent, definitions, seen),
  )
  return [definition, ...inherited]
}

/** True when any of `roleNames`, or anything they inherit, grants `action`. */
export function rolesGrant(
  roleNames: readonly RoleName[],
  action: string,
  definitions: readonly RoleDefinition[],
): boolean {
  const effective = new Map<RoleName, RoleDefinition>()
  for (const name of roleNames) {
    for (const definition of expandRole(name, definitions)) {
      effective.set(definition.name, definition)
    }
  }
  for (const definition of effective.values()) {
    if (definition.grants.some((pattern) => grantMatches(pattern, action))) return true
  }
  return false
}

/** Every role name implied by an assignment set, including inherited ones. */
export function effectiveRoleNames(
  roleNames: readonly RoleName[],
  definitions: readonly RoleDefinition[],
): RoleName[] {
  const names = new Set<RoleName>()
  for (const name of roleNames) {
    for (const definition of expandRole(name, definitions)) names.add(definition.name)
  }
  return [...names]
}
