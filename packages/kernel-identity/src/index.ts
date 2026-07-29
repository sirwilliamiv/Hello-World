/**
 * @forge/kernel-identity — the runtime half of kernel.identity@1.0.0.
 *
 * Everything the specification's `exposes` block declares is exported here, and
 * the generated half is the ten-line route in
 * templates/kernel.identity/auth-routes.ts.tmpl plus the three slot stubs.
 */

// ── exposes: interface ───────────────────────────────────────────────────────
export { currentUser, currentSession, currentAuthentication } from './context.js'
export { AuthGuard, withIdentity } from './guard.js'

// ── exposes: route ───────────────────────────────────────────────────────────
export { authHandler, type AuthHandlerOptions } from './handler.js'

// ── exposes: ui_surface ──────────────────────────────────────────────────────
export { AccountSettings, type AccountSettingsProps } from './AccountSettings.js'

// ── slots (types imported by the generated stubs) ────────────────────────────
export {
  builtInPasswordPolicy,
  defaultOnRegistration,
  defaultPasswordPolicy,
  defaultPostLoginRedirect,
  onRegistrationContext,
  passwordPolicyContext,
  postLoginRedirectContext,
  resolveSlots,
  MINIMUM_PASSWORD_LENGTH,
  type IdentitySlots,
  type OnRegistrationContext,
  type OnRegistrationInput,
  type OnRegistrationSlot,
  type PasswordPolicyContext,
  type PasswordPolicyInput,
  type PasswordPolicyResult,
  type PasswordPolicySlot,
  type PostLoginRedirectContext,
  type PostLoginRedirectInput,
  type PostLoginRedirectSlot,
} from './slots.js'

// ── the user lifecycle ───────────────────────────────────────────────────────
export {
  changePassword,
  disableUser,
  getUser,
  issueEmailVerification,
  login,
  normalizeEmail,
  register,
  requestPasswordReset,
  resetPassword,
  sameOriginPath,
  updateUser,
  verifyEmail,
  type IssuedVerification,
  type LoginInput,
  type LoginResult,
  type RegisterInput,
  type RegisterResult,
} from './users.js'

// ── sessions ─────────────────────────────────────────────────────────────────
export {
  authenticateToken,
  endAllSessions,
  endSession,
  listSessions,
  startSession,
  type StartSessionInput,
  type StartedSession,
} from './sessions.js'

// ── privacy handlers named in `owns[].privacy` ───────────────────────────────
export {
  anonymizeUser,
  deleteCredentials,
  deleteResets,
  deleteSessions,
  deleteVerifications,
  exportCredentialMetadata,
  exportResets,
  exportSessions,
  exportUser,
  exportVerifications,
} from './privacy.js'

// ── events this capability publishes ─────────────────────────────────────────
export {
  publishIdentityEvent,
  IDENTITY_EVENT_CONTRACT_VERSIONS,
  type IdentityEventName,
  type IdentityEventPayloads,
} from './events.js'

// ── configuration, schema, and the kernel-package seam ───────────────────────
export {
  configureIdentity,
  identityConfig,
  resetIdentityConfig,
  type IdentityConfig,
} from './config.js'
export {
  contextFromRequest,
  identityContext,
  readSessionCookie,
  runWithIdentityContext,
  type IdentityRequestContext,
} from './context.js'
export {
  ENTITY,
  credentials,
  emailVerifications,
  identitySchema,
  passwordResets,
  sessions,
  users,
  type EntityName,
} from './schema.js'
export {
  identityRuntime,
  repository,
  resetIdentityRuntime,
  setIdentityRuntime,
  type IdentityRuntime,
  type New,
  type RepositoryApi,
  type Where,
} from './runtime.js'
export { hashPassword, needsRehash, verifyPassword } from './password.js'
export { generateToken, hashToken } from './tokens.js'
export { clearedSessionCookie, json, sessionCookie } from './http.js'

// ── errors and domain types ──────────────────────────────────────────────────
export {
  AccountDisabledError,
  EmailInUseError,
  EmailNotVerifiedError,
  IdentityError,
  InvalidCredentialsError,
  InvalidTokenError,
  NotAuthenticatedError,
  PasswordRejectedError,
  UserNotFoundError,
} from './errors.js'
export type {
  Authentication,
  BaseRow,
  Credential,
  CredentialKind,
  EmailVerification,
  PasswordReset,
  RouteContext,
  RouteHandler,
  Session,
  User,
} from './types.js'
