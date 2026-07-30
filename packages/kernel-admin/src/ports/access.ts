/**
 * The kernel.access permission check, as kernel.admin consumes it.
 *
 * Spec: `can(user: User, action: string, resource?: ResourceRef): Promise<boolean>`
 * — "The permission check every capability calls. access.rebac must satisfy
 * this exact signature to upgrade this capability."
 *
 * kernel.admin calls `can()` and nothing else, so when `access.rebac`
 * supersedes `kernel.access` (§3, upgrade substitution) the import path is
 * unchanged and every admin surface is silently re-gated through relationship
 * tuples instead of roles. That is the substitution working as designed.
 */

/** The permissions kernel.admin registers into `kernel.access:permissions`. */
export const ADMIN_ACCESS = 'admin.access' as const
export const ADMIN_EXPORT = 'admin.export' as const

/**
 * The subset of `User` kernel.admin touches. kernel.admin does not `require`
 * kernel.identity, so it must not depend on the concrete type; it only ever
 * passes the user through to `can()`.
 */
export interface AdminUser {
  readonly id: string
  readonly [key: string]: unknown
}

/** A specific row, when the check is row-level rather than surface-level. */
export interface ResourceRef {
  readonly type: string
  readonly id?: string
}

export type CanFn = (
  user: AdminUser,
  action: string,
  resource?: ResourceRef,
) => Promise<boolean> | boolean

let checker: CanFn | undefined

/** Install the permission checker. Tests and previews use this. */
export function setPermissionChecker(next: CanFn | undefined): void {
  checker = next
}

interface KernelAccessModule {
  readonly can?: CanFn
}

/**
 * Check a permission.
 *
 * Falls back to `@forge/kernel-access`'s `can` when no checker has been
 * installed, and denies if the module does not expose one. Denying is the only
 * safe default: an admin console that opens when its permission layer is
 * missing is a data breach, not a degraded experience.
 */
export async function can(
  user: AdminUser | null | undefined,
  action: string,
  resource?: ResourceRef,
): Promise<boolean> {
  if (user === null || user === undefined) return false

  if (checker === undefined) {
    try {
      const mod = (await import('@forge/kernel-access')) as unknown as KernelAccessModule
      if (typeof mod.can !== 'function') return false
      checker = mod.can
    } catch {
      return false
    }
  }

  return resource === undefined
    ? await checker(user, action)
    : await checker(user, action, resource)
}
