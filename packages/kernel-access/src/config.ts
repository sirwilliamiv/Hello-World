import { BUILT_IN_ROLES } from './roles.js'
import {
  defaultPermissionResolver,
  defaultRoleDefinitions,
  roleDefinitionsContext,
  type AccessSlots,
} from './slots.js'
import type { RoleDefinition, RoleName } from './types.js'

export interface AccessConfig {
  /** Assigned by `assignDefaultRole` when `identity.user.created` arrives. */
  defaultRole: RoleName
  /**
   * The client's slot implementations —
   * `import * as slots from '@/slots/kernel.access'`.
   *
   * There is no generated wiring that passes these in (kernel.access's only
   * managed template is the permission list), so the host calls
   * `configureAccess({ slots })` once at boot.
   */
  slots: Partial<AccessSlots>
}

const defaults: AccessConfig = {
  defaultRole: 'member',
  slots: {},
}

let current: AccessConfig = { ...defaults, slots: {} }
let resolvedRoles: RoleDefinition[] | null = null

export function configureAccess(patch: Partial<AccessConfig>): void {
  current = { ...current, ...patch }
  // The role set is resolved once per configuration, not once per can() call.
  resolvedRoles = null
}

export function accessConfig(): AccessConfig {
  return current
}

export function resetAccessConfig(): void {
  current = { ...defaults, slots: {} }
  resolvedRoles = null
}

/**
 * The role set for this product: the four built-ins, passed through the
 * client's `roleDefinitions` slot. Memoised until the configuration changes.
 */
export async function roleDefinitions(): Promise<RoleDefinition[]> {
  if (resolvedRoles !== null) return resolvedRoles
  const slot = current.slots.roleDefinitions ?? defaultRoleDefinitions
  resolvedRoles = await slot(roleDefinitionsContext(BUILT_IN_ROLES))
  return resolvedRoles
}

export function permissionResolver(): AccessSlots['permissionResolver'] {
  return current.slots.permissionResolver ?? defaultPermissionResolver
}
