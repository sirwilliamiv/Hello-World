/**
 * Drizzle schema for the three tables `docs.generation` owns.
 *
 * `docs_generation_template_version` has no update path anywhere in this package, and
 * the migration adds a trigger that refuses one at the database level as well —
 * append-only is the guarantee a reissued document rests on, and a guarantee that
 * only application code keeps is a guarantee until someone opens psql.
 */
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

export const documentTemplatesTable = pgTable(
  'docs_generation_template',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    currentVersion: integer('current_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('docs_generation_template_key_idx').on(t.key)],
)

export const templateVersionsTable = pgTable(
  'docs_generation_template_version',
  {
    id: text('id').primaryKey(),
    templateId: text('template_id').notNull(),
    version: integer('version').notNull(),
    source: text('source').notNull(),
    sourceHash: text('source_hash').notNull(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('docs_generation_template_version_idx').on(t.templateId, t.version)],
)

export const generatedDocumentsTable = pgTable(
  'docs_generation_document',
  {
    id: text('id').primaryKey(),
    templateId: text('template_id').notNull(),
    templateKey: text('template_key').notNull(),
    /** The pin. Never a foreign key to "current". */
    templateVersion: integer('template_version').notNull(),
    format: text('format').notNull(),
    fileId: text('file_id'),
    contentHash: text('content_hash').notNull(),
    dataHash: text('data_hash').notNull(),
    /** Canonical JSON of the render inputs, so the document can be reissued. */
    data: jsonb('data'),
    subjectRef: text('subject_ref'),
    generatedBy: text('generated_by'),
    anonymisedAt: timestamp('anonymised_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('docs_generation_document_subject_idx').on(t.subjectRef),
    index('docs_generation_document_template_idx').on(t.templateId, t.templateVersion),
    index('docs_generation_document_content_idx').on(t.contentHash),
  ],
)

export const docsGenerationSchema = {
  documentTemplatesTable,
  templateVersionsTable,
  generatedDocumentsTable,
}
