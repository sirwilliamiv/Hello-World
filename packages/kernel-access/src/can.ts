import { permissionResolver, roleDefinitions } from './config.js'
import { permissions } from './permissions.js'
import { effectiveRoleNames, rolesGrant } from './roles.js'
import { rolesFor } from './assignments.js'
import type { ResourceRef, RoleName, User } from './types.js'

/**
 * `can(user: User, action: string, resource?: ResourceRef): Promise<boolean>`
 *
 * The permission check every capability calls, and the one interface that
 * cannot change shape: `access.rebac` declares `upgrades: kernel.access` and
 * validation check 6 compares the two `exposes` blocks, so an incompatible
 * signature here would break every consumer the day fine-grained permissions
 * are enabled. Everything below the signature is replaceable; the signature is
 * not.
 *
 * Decision order, first match wins:
 *
 *   1. No user, or a disabled one              → deny
 *   2. A role the user holds grants the action → allow   (owner grants `*`)
 *   3. The permission's declared default_roles → allow
 *   4. The `permissionResolver` slot           → allow / deny / abstain
 *   5. Default                                 → deny
 */
export async function can(
  user: User,
  action: string,
  resource?: ResourceRef,
): Promise<boolean> {
  if (user === null || user === undefined) return false
  if (user.disabledAt !== null || user.deletedAt !== null) return false

  const scope = resource?.scope
  const definitions = await roleDefinitions()
  const held = await rolesFor(user.id, scope)

  if (rolesGrant(held, action, definitions)) return true

  const effective = effectiveRoleNames(held, definitions)
  const declaration = permissions.get(action)
  const declared = declaration?.defaultRoles ?? []
  if (declared.some((role) => effective.includes(role))) return true

  const resolved = await permissionResolver()({
    user,
    action,
    resource,
    roles: effective,
    declaration,
  })
  return resolved === true
}

/** `can` for several actions at once. True only when every one is allowed. */
export async function canAll(
  user: User,
  actions: readonly string[],
  resource?: ResourceRef,
): Promise<boolean> {
  for (const action of actions) {
    if (!(await can(user, action, resource))) return false
  }
  return true
}

/** Every registered action this user may perform. Backs UI affordance checks. */
export async function allowedActions(
  user: User,
  resource?: ResourceRef,
): Promise<string[]> {
  const allowed: string[] = []
  for (const action of permissions.actions()) {
    if (await can(user, action, resource)) allowed.push(action)
  }
  return allowed
}

/** True when the user holds `role` (or a role that inherits it) in `scope`. */
export async function hasRole(
  user: User,
  role: RoleName,
  scope?: string | null,
): Promise<boolean> {
  const definitions = await roleDefinitions()
  const effective = effectiveRoleNames(await rolesFor(user.id, scope), definitions)
  return effective.includes(role)
}
