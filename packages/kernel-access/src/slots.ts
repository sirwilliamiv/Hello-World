import type { PermissionDeclaration, ResourceRef, RoleDefinition, RoleName, User } from './types.js'

/**
 * Slot types for kernel.access. The generated stubs in
 * `src/slots/kernel.access/` import these, so a signature change in a major
 * version breaks the client's build rather than its authorisation.
 */

/**
 * Runs at boot, when the role set is resolved. Receives the built-in roles and
 * returns the full set the product uses — add client-specific roles, or retune
 * the grants of an existing one.
 */
export type RoleDefinitionsSlot = (
  builtIn: readonly RoleDefinition[],
) => RoleDefinition[] | Promise<RoleDefinition[]>

export interface PermissionResolverContext {
  user: User
  action: string
  resource: ResourceRef | undefined
  /** The user's assignments, expanded through inheritance. */
  roles: RoleName[]
  /** The registry entry for this action, when one was declared. */
  declaration: PermissionDeclaration | undefined
}

/**
 * Runs on every `can()` call not already satisfied by a declared role.
 *
 * Return `true` to grant, `false` to deny outright, or `null` to abstain — a
 * slot that abstains leaves the decision at the default, which is deny.
 */
export type PermissionResolverSlot = (
  ctx: PermissionResolverContext,
) => boolean | null | Promise<boolean | null>

export interface AccessSlots {
  roleDefinitions: RoleDefinitionsSlot
  permissionResolver: PermissionResolverSlot
}

export const defaultRoleDefinitions: RoleDefinitionsSlot = (builtIn) => [...builtIn]

export const defaultPermissionResolver: PermissionResolverSlot = () => null
