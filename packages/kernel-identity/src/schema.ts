import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

/**
 * Drizzle table definitions for the five entities kernel.identity owns.
 *
 * Per ARCHITECTURE.md §14.1 the schema is TypeScript that composes across
 * packages, so each capability owns its own tables in its own npm package;
 * migrations are the hand-written SQL under `migrations/`, not a drizzle-kit
 * diff. These definitions and that SQL must agree — the migration is the
 * authority, this is the typed view of it.
 *
 * None of these entities is tenant-scoped (see `owns` in the specification), so
 * no organization column appears here. `org.teams` adds one to tenant-scoped
 * entities only, and scoping is bound by `Repository` rather than by any
 * predicate written here (§14.2).
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}

export const users = pgTable(
  'identity_users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    anonymizedAt: timestamp('anonymized_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex('identity_users_email_key').on(table.email)],
)

export const sessions = pgTable(
  'identity_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('identity_sessions_token_hash_key').on(table.tokenHash),
    index('identity_sessions_user_id_idx').on(table.userId),
  ],
)

export const credentials = pgTable(
  'identity_credentials',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    kind: text('kind').notNull(),
    secret: text('secret').notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex('identity_credentials_user_kind_key').on(table.userId, table.kind)],
)

export const emailVerifications = pgTable(
  'identity_email_verifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex('identity_email_verifications_token_hash_key').on(table.tokenHash)],
)

export const passwordResets = pgTable(
  'identity_password_resets',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    requestedIp: text('requested_ip'),
    ...timestamps,
  },
  (table) => [uniqueIndex('identity_password_resets_token_hash_key').on(table.tokenHash)],
)

/** Everything this capability contributes to the composed Drizzle schema. */
export const identitySchema = {
  users,
  sessions,
  credentials,
  emailVerifications,
  passwordResets,
}

/**
 * Entity names as registered with kernel.data. The generated
 * `src/generated/kernel.data/entities.ts` registers these by name, and every
 * `Repository(...)` call in this package uses one of them.
 */
export const ENTITY = {
  user: 'User',
  session: 'Session',
  credential: 'Credential',
  emailVerification: 'EmailVerification',
  passwordReset: 'PasswordReset',
} as const

export type EntityName = (typeof ENTITY)[keyof typeof ENTITY]
