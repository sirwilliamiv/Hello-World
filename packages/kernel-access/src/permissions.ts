import type { PermissionDeclaration, RoleName } from './types.js'

/**
 * The `permissions` registry declared in `exposes`.
 *
 * Every capability with protected surfaces contributes here through its
 * `registers: [{ registry: "kernel.access:permissions", entries: [...] }]`
 * block. The generated `src/generated/kernel.access/permissions.ts` calls
 * `registerPermission` once per collected action, so adding a capability adds
 * its permissions with no further work.
 *
 * Two accepted forms:
 *   registerPermission('invoice.void')
 *   registerPermission({ action: 'invoice.void', defaultRoles: ['owner'] })
 *
 * The template renders the first because the resolved graph carries only the
 * action string today (internal/render/render.go collects `entry["action"]` and
 * discards `default_roles`). The object form is here so that when the renderer
 * carries the roles through, no package change is needed.
 */

const declarations = new Map<string, PermissionDeclaration>()

function normalize(entry: string | PermissionDeclaration): PermissionDeclaration {
  return typeof entry === 'string' ? { action: entry } : entry
}

export interface PermissionRegistry {
  register(entry: string | PermissionDeclaration): PermissionDeclaration
  all(): PermissionDeclaration[]
  actions(): string[]
  get(action: string): PermissionDeclaration | undefined
  has(action: string): boolean
  /** Roles granted this action by declaration. Empty when none were carried. */
  defaultRolesFor(action: string): RoleName[]
  clear(): void
}

export const permissions: PermissionRegistry = {
  register(entry) {
    const declaration = normalize(entry)
    const existing = declarations.get(declaration.action)
    if (existing === undefined) {
      declarations.set(declaration.action, declaration)
      return declaration
    }
    // Re-registration is idempotent, and never narrows what is already granted.
    const merged: PermissionDeclaration = {
      action: declaration.action,
      ...(declaration.description ?? existing.description
        ? { description: declaration.description ?? existing.description }
        : {}),
      ...(declaration.defaultRoles !== undefined || existing.defaultRoles !== undefined
        ? {
            defaultRoles: [
              ...new Set([...(existing.defaultRoles ?? []), ...(declaration.defaultRoles ?? [])]),
            ],
          }
        : {}),
    }
    declarations.set(merged.action, merged)
    return merged
  },

  all() {
    return [...declarations.values()].sort((a, b) => a.action.localeCompare(b.action))
  },

  actions() {
    return this.all().map((declaration) => declaration.action)
  },

  get(action) {
    return declarations.get(action)
  },

  has(action) {
    return declarations.has(action)
  },

  defaultRolesFor(action) {
    return declarations.get(action)?.defaultRoles ?? []
  },

  clear() {
    declarations.clear()
  },
}

/** The function the generated permissions file calls, once per action. */
export function registerPermission(entry: string | PermissionDeclaration): PermissionDeclaration {
  return permissions.register(entry)
}
