import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

/**
 * Drizzle tables for the two entities kernel.access owns. Both are declared
 * `tenant_scoped: true`; the organization column arrives with `org.teams` and
 * the predicate is bound by kernel.data's Repository, so nothing here mentions
 * a tenant.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}

export const roles = pgTable(
  'access_roles',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    grants: jsonb('grants').$type<string[]>().notNull().default([]),
    inherits: jsonb('inherits').$type<string[]>().notNull().default([]),
    rank: integer('rank').notNull().default(0),
    builtIn: boolean('built_in').notNull().default(false),
    ...timestamps,
  },
  (table) => [uniqueIndex('access_roles_name_key').on(table.name)],
)

export const roleAssignments = pgTable(
  'access_role_assignments',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    role: text('role').notNull(),
    scope: text('scope'),
    grantedBy: text('granted_by'),
    ...timestamps,
  },
  (table) => [
    index('access_role_assignments_user_id_idx').on(table.userId),
    // NULLS NOT DISTINCT so a second global grant of the same role collides
    // rather than silently duplicating; see the migration for the SQL.
    uniqueIndex('access_role_assignments_unique').on(table.userId, table.role, table.scope),
  ],
)

export const accessSchema = { roles, roleAssignments }

export const ENTITY = {
  role: 'Role',
  roleAssignment: 'RoleAssignment',
} as const

export type EntityName = (typeof ENTITY)[keyof typeof ENTITY]
