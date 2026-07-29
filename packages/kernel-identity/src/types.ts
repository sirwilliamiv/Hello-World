/**
 * Domain types for kernel.identity.
 *
 * These mirror the entities declared in `owns` in
 * catalog/kernel/kernel.identity.capability.json. Row shapes are what
 * `Repository<T>` from @forge/kernel-data returns; `id`, `createdAt`,
 * `updatedAt` and `deletedAt` are supplied by the data layer.
 */

/** Fields every kernel.data-backed row carries. */
export interface BaseRow {
  id: string
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

/**
 * The shared identity primitive. Only the kernel may define this
 * (ARCHITECTURE.md §9.3).
 */
export interface User extends BaseRow {
  /** Normalised (trimmed, lower-cased) address. Unique. */
  email: string
  name: string | null
  emailVerifiedAt: Date | null
  /** Set when access is suspended; a disabled user cannot authenticate. */
  disabledAt: Date | null
  /** Set by `anonymizeUser`. Deletion strategy for User is anonymise, not delete. */
  anonymizedAt: Date | null
}

export interface Session extends BaseRow {
  userId: string
  /** SHA-256 of the opaque bearer token. The token itself is never stored. */
  tokenHash: string
  expiresAt: Date
  /** Non-null means revoked. Checked on every authentication — revocation is immediate. */
  revokedAt: Date | null
  revokedReason: string | null
  ip: string | null
  userAgent: string | null
  lastSeenAt: Date | null
}

export type CredentialKind = 'password'

export interface Credential extends BaseRow {
  userId: string
  kind: CredentialKind
  /** Encoded KDF output — see src/password.ts. Never exported in plaintext. */
  secret: string
  rotatedAt: Date | null
}

export interface EmailVerification extends BaseRow {
  userId: string
  /** The address being proved, which may differ from the user's current one. */
  email: string
  tokenHash: string
  expiresAt: Date
  consumedAt: Date | null
}

export interface PasswordReset extends BaseRow {
  userId: string
  tokenHash: string
  expiresAt: Date
  consumedAt: Date | null
  requestedIp: string | null
}

/**
 * A Next.js App Router route handler.
 *
 * `AuthGuard(handler: RouteHandler): RouteHandler` in the specification's
 * `exposes` block refers to this type, and kernel.access's `Guard` is defined
 * in terms of it.
 */
export interface RouteContext {
  // A Promise, and not optional. Next 15 made dynamic route params async and
  // types a route export's second argument as `{ params: Promise<any> }`. A
  // union with the synchronous form, or an optional marker, is not assignable
  // to that — so the generated `export const GET = handler` fails the framework's
  // own route validation even though the code is correct.
  params: Promise<Record<string, string | string[] | undefined>>
}

// Context is REQUIRED, not optional. Next.js types a route export as
// (request, context: RouteContext), and an optional second parameter is not
// assignable to that — `RouteContext | undefined` is not `RouteContext`. A
// handler that does not need the context simply ignores the argument.
export type RouteHandler = (request: Request, context: RouteContext) => Promise<Response>

/** Everything an authenticated request knows about its caller. */
export interface Authentication {
  user: User
  session: Session
}
