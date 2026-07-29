import type { RouteHandler, User } from '@forge/kernel-identity'

/** Row fields the data layer supplies. */
export interface BaseRow {
  id: string
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

/** The four roles this capability ships. Clients add more via `roleDefinitions`. */
export type BuiltInRole = 'owner' | 'admin' | 'member' | 'viewer'

export type RoleName = BuiltInRole | (string & {})

/**
 * A role and the permission patterns it grants.
 *
 * `grants` entries are either an exact action (`invoice.void`) or a glob
 * (`invoice.*`, `*`). Roles compose through `inherits`, which is how `admin`
 * picks up everything `member` can do without restating it.
 */
export interface RoleDefinition {
  name: RoleName
  description?: string
  grants: string[]
  inherits?: RoleName[]
  /** Higher outranks lower. Used for ordering and for "at least" comparisons. */
  rank: number
}

/** A permission contributed to the registry by a capability's `registers` block. */
export interface PermissionDeclaration {
  action: string
  description?: string
  /**
   * Roles granted this action by default. Comes from `default_roles` in the
   * contributing capability's `registers` entry.
   */
  defaultRoles?: RoleName[]
}

/**
 * The thing a permission is being checked against.
 *
 * Deliberately open: `access.rebac` upgrades this capability and must satisfy
 * `can(user, action, resource?)` unchanged, so the resource shape has to be
 * expressive enough for a relation-based check without changing the signature.
 */
export interface ResourceRef {
  type: string
  id?: string
  /**
   * The scope a role assignment must match — an organization id under
   * `org.teams`. A globally-scoped assignment (scope null) satisfies any scope.
   */
  scope?: string | null
  attributes?: Record<string, unknown>
}

/** `RequirePermission(action: string): Guard` returns one of these. */
export type Guard = (handler: RouteHandler) => RouteHandler

/** The Role table. Persisted so clients can manage roles without a deploy. */
export interface Role extends BaseRow {
  name: RoleName
  description: string | null
  grants: string[]
  inherits: RoleName[]
  rank: number
  /** Built-in roles are seeded by migration and cannot be deleted. */
  builtIn: boolean
}

export interface RoleAssignment extends BaseRow {
  userId: string
  role: RoleName
  /** null means the assignment applies everywhere. */
  scope: string | null
  grantedBy: string | null
}

export type { RouteHandler, User }
