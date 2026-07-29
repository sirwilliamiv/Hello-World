import { accessConfig, roleDefinitions } from './config.js'
import { publishAccessEvent, type IncomingEvent } from './events.js'
import { effectiveRoleNames } from './roles.js'
import { repository } from './runtime.js'
import { ENTITY } from './schema.js'
import type { RoleAssignment, RoleName } from './types.js'

export interface GrantOptions {
  /** null (the default) grants the role everywhere. */
  scope?: string | null
  /** User id of whoever granted it, for the audit trail. */
  grantedBy?: string | null
}

/** Assignments held by a user, optionally narrowed to one scope. */
export async function assignmentsFor(
  userId: string,
  scope?: string | null,
): Promise<RoleAssignment[]> {
  const assignments = await repository<RoleAssignment>(ENTITY.roleAssignment)
  const all = await assignments.findMany({ userId })
  if (scope === undefined) return all
  // A globally-scoped assignment satisfies every scope.
  return all.filter((assignment) => assignment.scope === null || assignment.scope === scope)
}

/** Role names a user directly holds, without expanding inheritance. */
export async function rolesFor(userId: string, scope?: string | null): Promise<RoleName[]> {
  const assignments = await assignmentsFor(userId, scope)
  return [...new Set(assignments.map((assignment) => assignment.role))]
}

/** Role names a user effectively holds, inheritance expanded. */
export async function effectiveRolesFor(
  userId: string,
  scope?: string | null,
): Promise<RoleName[]> {
  return effectiveRoleNames(await rolesFor(userId, scope), await roleDefinitions())
}

/** Grant a role. Idempotent, and publishes `access.role.granted` once. */
export async function grantRole(
  userId: string,
  role: RoleName,
  options: GrantOptions = {},
): Promise<RoleAssignment> {
  const scope = options.scope ?? null
  const assignments = await repository<RoleAssignment>(ENTITY.roleAssignment)
  const existing = await assignments.find({ userId, role, scope })
  if (existing !== null) return existing

  const assignment = await assignments.create({
    userId,
    role,
    scope,
    grantedBy: options.grantedBy ?? null,
  })

  await publishAccessEvent('access.role.granted', { user_id: userId, role, scope })
  return assignment
}

/** Revoke a role. Idempotent, and publishes `access.role.revoked` once. */
export async function revokeRole(
  userId: string,
  role: RoleName,
  options: { scope?: string | null } = {},
): Promise<void> {
  const scope = options.scope ?? null
  const assignments = await repository<RoleAssignment>(ENTITY.roleAssignment)
  const existing = await assignments.find({ userId, role, scope })
  if (existing === null) return

  await assignments.softDelete(existing.id)
  await publishAccessEvent('access.role.revoked', { user_id: userId, role, scope })
}

/**
 * Handler for the `identity.user.created` consumption declared in the
 * specification. The generated `src/generated/kernel.events/subscriptions.ts`
 * wires it:
 *
 *   subscribe('identity.user.created', assignDefaultRole)
 *
 * A user with no role can do nothing, so this is what makes registration
 * produce a usable account.
 */
export async function assignDefaultRole(event: IncomingEvent): Promise<void> {
  const payload = event.payload as { user_id?: unknown } | null
  const userId = typeof payload?.user_id === 'string' ? payload.user_id : null
  if (userId === null) {
    throw new Error(
      `identity.user.created carried no user_id; cannot assign the default role (got ${JSON.stringify(event.payload)})`,
    )
  }
  await grantRole(userId, accessConfig().defaultRole, { grantedBy: null })
}

/** Every user holding a role, for administration surfaces. */
export async function usersWithRole(
  role: RoleName,
  scope?: string | null,
): Promise<RoleAssignment[]> {
  const assignments = await repository<RoleAssignment>(ENTITY.roleAssignment)
  const rows = await assignments.findMany({ role })
  if (scope === undefined) return rows
  return rows.filter((assignment) => assignment.scope === null || assignment.scope === scope)
}
