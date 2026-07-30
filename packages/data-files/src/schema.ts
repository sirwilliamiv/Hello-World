/**
 * Drizzle schema for the four tables `data.files` owns. It composes into the
 * product's schema from this package — no capability's tables are ever written into
 * the client repository (ARCHITECTURE.md section 14.1).
 *
 * The migrations that create these tables are hand-written SQL under `migrations/`,
 * because a generated diff cannot express a backfill and cannot be rolled back.
 */
import { index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

export const filesTable = pgTable(
  'data_files_file',
  {
    id: text('id').primaryKey(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    ownerId: text('owner_id'),
    checksum: text('checksum'),
    storageKey: text('storage_key').notNull(),
    /** awaiting_upload | scanning | available | quarantined | deleted */
    status: text('status').notNull().default('awaiting_upload'),
    /** pending | clean | infected | unavailable | skipped */
    scanStatus: text('scan_status').notNull().default('pending'),
    scanner: text('scanner'),
    quarantineReason: text('quarantine_reason'),
    attachedToEntity: text('attached_to_entity'),
    attachedToId: text('attached_to_id'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('data_files_file_storage_key_idx').on(t.storageKey),
    index('data_files_file_attachment_idx').on(t.attachedToEntity, t.attachedToId),
    index('data_files_file_owner_idx').on(t.ownerId),
    index('data_files_file_status_idx').on(t.status),
  ],
)

export const fileVersionsTable = pgTable(
  'data_files_file_version',
  {
    id: text('id').primaryKey(),
    fileId: text('file_id').notNull(),
    version: integer('version').notNull(),
    storageKey: text('storage_key').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    checksum: text('checksum'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('data_files_file_version_idx').on(t.fileId, t.version)],
)

export const uploadSessionsTable = pgTable(
  'data_files_upload_session',
  {
    id: text('id').primaryKey(),
    fileId: text('file_id').notNull(),
    storageKey: text('storage_key').notNull(),
    method: text('method').notNull(),
    url: text('url').notNull(),
    contentType: text('content_type').notNull(),
    maxSizeBytes: integer('max_size_bytes').notNull(),
    ownerId: text('owner_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('data_files_upload_session_expiry_idx').on(t.expiresAt)],
)

export const thumbnailsTable = pgTable(
  'data_files_thumbnail',
  {
    id: text('id').primaryKey(),
    fileId: text('file_id').notNull(),
    kind: text('kind').notNull(),
    storageKey: text('storage_key').notNull(),
    width: integer('width'),
    height: integer('height'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('data_files_thumbnail_kind_idx').on(t.fileId, t.kind)],
)

export const dataFilesSchema = {
  filesTable,
  fileVersionsTable,
  uploadSessionsTable,
  thumbnailsTable,
}

export type FilesTable = typeof filesTable
