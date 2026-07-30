import { AuthGuard, currentUser, json } from '@forge/kernel-identity'

import { can } from './can.js'
import type { Guard, ResourceRef, RouteHandler } from './types.js'

/**
 * `RequirePermission(action: string): Guard`
 *
 * Composes on top of kernel.identity's `AuthGuard` rather than repeating it:
 * authentication is identity's concern, authorisation is this capability's.
 * An unauthenticated caller gets 401 from the inner guard; an authenticated one
 * lacking the permission gets 403 from here.
 */
export function RequirePermission(
  action: string,
  resource?: ResourceRef | ((request: Request) => ResourceRef | Promise<ResourceRef>),
): Guard {
  return (handler: RouteHandler): RouteHandler =>
    AuthGuard(async (request, context) => {
      const user = await currentUser()
      if (user === null) return json({ error: 'not_authenticated' }, 401)

      const target =
        typeof resource === 'function' ? await resource(request) : resource

      if (!(await can(user, action, target))) {
        return json({ error: 'forbidden', action }, 403)
      }
      return await handler(request, context)
    })
}

/** Require every one of several permissions. */
export function RequireAllPermissions(actions: readonly string[]): Guard {
  return (handler: RouteHandler): RouteHandler =>
    actions.reduceRight<RouteHandler>(
      (wrapped, action) => RequirePermission(action)(wrapped),
      handler,
    )
}
