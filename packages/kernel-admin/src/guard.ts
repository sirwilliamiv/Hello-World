/**
 * Permission gating.
 *
 * Spec: surfaces[0] declares `permission: "admin.access"`, and the smoke test
 * requires that "a user without admin.access receives 403 on every admin
 * route". Gating therefore lives at the route boundary in routes.ts and is
 * unconditional — a view is never resolved for a user who has not passed
 * {@link requireAdmin} first, so a bug in a view cannot become a disclosure.
 */

import { ADMIN_ACCESS, can, type AdminUser, type ResourceRef } from './ports/access.js'

export class AdminForbiddenError extends Error {
  readonly status = 403
  readonly action: string
  readonly resource: ResourceRef | undefined

  constructor(action: string, resource?: ResourceRef) {
    super(`Forbidden: ${action}`)
    this.name = 'AdminForbiddenError'
    this.action = action
    this.resource = resource
  }
}

export class AdminNotFoundError extends Error {
  readonly status = 404
  constructor(message: string) {
    super(message)
    this.name = 'AdminNotFoundError'
  }
}

/**
 * Throw unless the user holds the permission.
 *
 * `can()` is the kernel.access interface; when access.rebac supersedes
 * kernel.access this call is re-bound to the ReBAC implementation with no
 * change here, which is the substitution rule in §3 doing its job.
 */
export async function requireAdmin(
  user: AdminUser | null | undefined,
  action: string = ADMIN_ACCESS,
  resource?: ResourceRef,
): Promise<void> {
  const allowed =
    resource === undefined ? await can(user, action) : await can(user, action, resource)
  if (!allowed) throw new AdminForbiddenError(action, resource)
}

/** As {@link requireAdmin}, but boolean — for hiding an action rather than refusing it. */
export async function mayAdmin(
  user: AdminUser | null | undefined,
  action: string = ADMIN_ACCESS,
  resource?: ResourceRef,
): Promise<boolean> {
  return resource === undefined ? can(user, action) : can(user, action, resource)
}

export function forbiddenResponse(action: string): Response {
  return new Response(
    JSON.stringify({ error: 'forbidden', action, message: `Requires ${action}.` }),
    { status: 403, headers: { 'content-type': 'application/json; charset=utf-8' } },
  )
}

export function notFoundResponse(message: string): Response {
  return new Response(JSON.stringify({ error: 'not_found', message }), {
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * Run `fn` only if the permission holds, translating a refusal into a 403.
 * Every route in routes.ts goes through this.
 */
export async function guarded(
  user: AdminUser | null | undefined,
  action: string,
  fn: () => Promise<Response> | Response,
): Promise<Response> {
  try {
    await requireAdmin(user, action)
  } catch (err) {
    if (err instanceof AdminForbiddenError) return forbiddenResponse(err.action)
    throw err
  }
  try {
    return await fn()
  } catch (err) {
    if (err instanceof AdminForbiddenError) return forbiddenResponse(err.action)
    if (err instanceof AdminNotFoundError) return notFoundResponse(err.message)
    throw err
  }
}
