import { contextFromRequest, currentAuthentication, runWithIdentityContext } from './context.js'
import { json } from './http.js'
import type { RouteHandler } from './types.js'

/**
 * `AuthGuard(handler: RouteHandler): RouteHandler`.
 *
 * Establishes the per-request identity context and refuses the request with 401
 * when no live session backs it. Because the context resolves through
 * `authenticateToken`, a session revoked a millisecond ago fails here.
 *
 * kernel.access's `RequirePermission` composes on top of this rather than
 * repeating it: authentication is identity's concern, authorisation is access's.
 */
export function AuthGuard(handler: RouteHandler): RouteHandler {
  return async (request, context) =>
    await runWithIdentityContext(contextFromRequest(request), async () => {
      const authentication = await currentAuthentication()
      if (authentication === null) {
        return json({ error: 'not_authenticated' }, 401)
      }
      return await handler(request, context)
    })
}

/**
 * Run `fn` with the identity context established from `request`, without
 * requiring authentication. Used by `authHandler`, and by any capability that
 * needs `currentUser()` to work inside its own route.
 */
export function withIdentity<T>(request: Request, fn: () => Promise<T>): Promise<T> {
  return runWithIdentityContext(contextFromRequest(request), fn)
}
