import { BUILT_IN_ROLES } from './roles.js'
import type { PermissionDeclaration, ResourceRef, RoleDefinition, RoleName, User } from './types.js'

/**
 * Slot types for kernel.access. The generated stubs in
 * `src/slots/kernel.access/` import these, so a signature change in a major
 * version breaks the client's build rather than its authorisation.
 *
 * Both slots take a single context object exposing `proceed()`, which returns
 * whatever this capability decides with no slot implemented
 * (schemas/capability.schema.json, `$defs.slot.signature`). The seeded stub is
 * therefore `async (ctx) => ctx.proceed()` and authorises exactly as an
 * unslotted product does.
 */

/* ----------------------------------------------------------- roleDefinitions */

export interface RoleDefinitionsContext {
  /** Owner, admin, member, viewer — the four roles kernel.access ships. */
  readonly builtIn: readonly RoleDefinition[]
  /** The built-in set, unchanged. That is the product's role set with no slot. */
  proceed(): RoleDefinition[]
}

/**
 * Runs at boot, when the role set is resolved. Returns the full set the product
 * uses — `[...ctx.proceed(), myRole]` to add a client-specific role, or a
 * rewritten copy to retune the grants of an existing one.
 */
export type RoleDefinitionsSlot = (
  ctx: RoleDefinitionsContext,
) => RoleDefinition[] | Promise<RoleDefinition[]>

/* -------------------------------------------------------- permissionResolver */

/** Grant, deny outright, or abstain and leave the decision at the default. */
export type PermissionDecision = boolean | null

export interface PermissionResolverContext {
  readonly user: User
  readonly action: string
  readonly resource: ResourceRef | undefined
  /** The user's assignments, expanded through inheritance. */
  readonly roles: RoleName[]
  /** The registry entry for this action, when one was declared. */
  readonly declaration: PermissionDeclaration | undefined
  /**
   * Abstain, which is what this capability does with no slot implemented: no
   * role and no declaration matched, so `can()` falls through to its default
   * of deny.
   */
  proceed(): PermissionDecision
}

/**
 * Runs on every `can()` call not already satisfied by a declared role.
 *
 * Return `true` to grant, `false` to deny outright, or `ctx.proceed()` to
 * abstain — an abstaining slot leaves the decision at the default, which is
 * deny.
 */
export type PermissionResolverSlot = (
  ctx: PermissionResolverContext,
) => PermissionDecision | Promise<PermissionDecision>

/* --------------------------------------------------------------------------- */

export interface AccessSlots {
  roleDefinitions: RoleDefinitionsSlot
  permissionResolver: PermissionResolverSlot
}

/* ---------------------------------------------------------- context builders */

/**
 * The call sites build their context through these, so each `proceed()` is
 * defined once and cannot drift from the path taken when the slot is absent.
 */

export function roleDefinitionsContext(
  builtIn: readonly RoleDefinition[] = BUILT_IN_ROLES,
): RoleDefinitionsContext {
  return { builtIn, proceed: () => [...builtIn] }
}

export function permissionResolverContext(
  input: Omit<PermissionResolverContext, 'proceed'>,
): PermissionResolverContext {
  return { ...input, proceed: () => null }
}

/* ----------------------------------------------------------------- defaults */

/** Identical to the seeded stub: carry on as the capability would have. */
export const defaultRoleDefinitions: RoleDefinitionsSlot = (ctx) => ctx.proceed()
export const defaultPermissionResolver: PermissionResolverSlot = (ctx) => ctx.proceed()
