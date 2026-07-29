/**
 * @forge/kernel-access — the runtime half of kernel.access@1.0.0.
 *
 * Owner, admin, member, viewer. Every capability with protected surfaces
 * declares its permissions here through `registers`. When `access.rebac` is
 * selected it supersedes this capability and must satisfy `can()` unchanged,
 * which is why no consumer has to be rewritten (ARCHITECTURE.md §3).
 */

// ── exposes: interface ───────────────────────────────────────────────────────
export { can, canAll, allowedActions, hasRole } from './can.js'
export { RequirePermission, RequireAllPermissions } from './guard.js'

// ── exposes: registry ────────────────────────────────────────────────────────
export {
  permissions,
  registerPermission,
  type PermissionRegistry,
} from './permissions.js'

// ── consumes: identity.user.created ──────────────────────────────────────────
export {
  assignDefaultRole,
  assignmentsFor,
  effectiveRolesFor,
  grantRole,
  revokeRole,
  rolesFor,
  usersWithRole,
  type GrantOptions,
} from './assignments.js'

// ── slots (types imported by the generated stubs) ────────────────────────────
export {
  defaultPermissionResolver,
  defaultRoleDefinitions,
  type AccessSlots,
  type PermissionResolverContext,
  type PermissionResolverSlot,
  type RoleDefinitionsSlot,
} from './slots.js'

// ── roles ────────────────────────────────────────────────────────────────────
export {
  BUILT_IN_ROLES,
  effectiveRoleNames,
  expandRole,
  grantMatches,
  rolesGrant,
} from './roles.js'

// ── events this capability publishes ─────────────────────────────────────────
export {
  publishAccessEvent,
  ACCESS_EVENT_CONTRACT_VERSIONS,
  type AccessEventName,
  type AccessEventPayloads,
  type IncomingEvent,
} from './events.js'

// ── configuration, schema, and the kernel-package seam ───────────────────────
export {
  accessConfig,
  configureAccess,
  permissionResolver,
  resetAccessConfig,
  roleDefinitions,
  type AccessConfig,
} from './config.js'
export {
  ENTITY,
  accessSchema,
  roleAssignments,
  roles,
  type EntityName,
} from './schema.js'
export {
  accessRuntime,
  repository,
  resetAccessRuntime,
  setAccessRuntime,
  type AccessRuntime,
  type New,
  type RepositoryApi,
  type Where,
} from './runtime.js'

// ── domain types ─────────────────────────────────────────────────────────────
export type {
  BaseRow,
  BuiltInRole,
  Guard,
  PermissionDeclaration,
  ResourceRef,
  Role,
  RoleAssignment,
  RoleDefinition,
  RoleName,
  RouteHandler,
  User,
} from './types.js'
