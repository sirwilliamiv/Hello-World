/**
 * The generic path.
 *
 * "Every entity in the system, including manifest-declared client entities,
 *  gets an admin surface automatically. This is the largest single reason
 *  client-specific entities belong in the manifest rather than in code."
 *
 * Everything below is a pure function of (entity registry, display registry,
 * client slots). No entity is special-cased, and there is no per-entity code
 * path — if the generic path did not genuinely work from the registry alone,
 * the manifest-declared-entity argument in the architecture would be false.
 *
 * Kept free of React so the resolution can be asserted directly, which is how
 * the spec's smoke test "each entity in the registry, including
 * manifest-declared ones, resolves a list and a detail view" is proved.
 */

import type { ComponentType } from 'react'

import { CLIENT_OWNER, adminEntities, type AdminEntityRegistration } from './entities.js'
import { entityLabel, entityPluralLabel, humanise } from './labels.js'
import { ADMIN_ACCESS, ADMIN_EXPORT } from './ports/access.js'
import type { EntityDescriptor, EntityFieldDescriptor, FieldType } from './ports/entities.js'
import { entitySource, loadEntitySource, type EntitySource } from './ports/entities.js'
import {
  bulkActionsFor,
  entityDisplay,
  type BulkAction,
  type ColumnConfig,
  type EntityDisplayConfig,
} from './registries.js'
import {
  identityBulkAction,
  identityCustomAdminView,
  identityEntityDisplayConfig,
  type AdminSlots,
  type CustomAdminViewProps,
} from './slots.js'

export const ADMIN_BASE_PATH = '/admin'

/** How a field is presented and edited. */
export type AdminControl =
  | 'text'
  | 'textarea'
  | 'number'
  | 'money'
  | 'checkbox'
  | 'date'
  | 'datetime'
  | 'email'
  | 'tel'
  | 'url'
  | 'json'
  | 'file'
  | 'select'
  | 'reference'
  | 'references'

export interface AdminField {
  readonly name: string
  readonly label: string
  readonly type: FieldType
  readonly control: AdminControl
  readonly required: boolean
  readonly readOnly: boolean
  readonly numeric: boolean
  readonly help?: string
  readonly options?: readonly string[]
  /** For `ref:`/`refs:` fields, the entity referenced. */
  readonly references?: string
}

export interface AdminColumn extends AdminField {
  readonly sortable: boolean
  readonly width?: string
}

export interface AdminFilter {
  readonly field: string
  readonly label: string
  readonly options: readonly { readonly value: string; readonly label: string }[]
}

export interface AdminListView {
  readonly entity: string
  readonly owner: string
  readonly isClientEntity: boolean
  readonly label: string
  readonly pluralLabel: string
  readonly path: string
  readonly permission: typeof ADMIN_ACCESS
  readonly exportPermission: typeof ADMIN_EXPORT
  readonly columns: readonly AdminColumn[]
  /** Fields free-text search covers. */
  readonly searchFields: readonly string[]
  readonly filters: readonly AdminFilter[]
  readonly defaultSort: { readonly field: string; readonly direction: 'asc' | 'desc' }
  readonly pageSize: number
  readonly bulkActions: readonly BulkAction[]
  readonly canCreate: boolean
  readonly canEdit: boolean
  readonly canDelete: boolean
  /** Every field the export includes, in order. */
  readonly exportFields: readonly string[]
  readonly custom: ComponentType<CustomAdminViewProps> | null
}

export interface AdminDetailSection {
  readonly title: string
  readonly fields: readonly AdminField[]
}

export interface AdminDetailView {
  readonly entity: string
  readonly owner: string
  readonly isClientEntity: boolean
  readonly label: string
  readonly path: (id: string) => string
  readonly permission: typeof ADMIN_ACCESS
  readonly titleField: string
  readonly sections: readonly AdminDetailSection[]
  readonly canEdit: boolean
  readonly canDelete: boolean
  readonly custom: ComponentType<CustomAdminViewProps> | null
}

export interface AdminFormView {
  readonly entity: string
  readonly label: string
  readonly mode: 'create' | 'edit'
  readonly fields: readonly AdminField[]
  readonly permission: typeof ADMIN_ACCESS
  readonly custom: ComponentType<CustomAdminViewProps> | null
}

export interface AdminEntityViews {
  readonly registration: AdminEntityRegistration
  readonly descriptor: EntityDescriptor
  readonly display: EntityDisplayConfig
  readonly list: AdminListView
  readonly detail: AdminDetailView
  readonly create: AdminFormView
  readonly edit: AdminFormView
}

export class UnknownAdminEntityError extends Error {
  readonly entity: string
  constructor(entity: string) {
    super(
      `Entity ${entity} is registered for admin but is not in the kernel.data entity ` +
        `registry. Check that src/generated/kernel.data/entities.ts (or the client ` +
        `entity registrations) declares it — kernel.admin generates every surface ` +
        `from that registry and cannot invent a schema.`,
    )
    this.name = 'UnknownAdminEntityError'
    this.entity = entity
  }
}

/**
 * Fields kernel.data adds to every entity. Not in the manifest declaration, but
 * present on every row, and an admin console that could not show `id` or sort
 * by `createdAt` would be useless on day one.
 */
const SYSTEM_FIELDS: readonly EntityFieldDescriptor[] = [
  { name: 'id', type: 'string', required: true },
  { name: 'createdAt', type: 'datetime', required: true },
  { name: 'updatedAt', type: 'datetime', required: true },
]

const SYSTEM_FIELD_NAMES = new Set(SYSTEM_FIELDS.map((f) => f.name))

/** Types too large or too structured to belong in a list row by default. */
const NOT_IN_LIST_BY_DEFAULT = new Set<string>(['text', 'json', 'file'])

const DEFAULT_LIST_COLUMNS = 6
const DEFAULT_PAGE_SIZE = 25

export function controlFor(field: EntityFieldDescriptor): AdminControl {
  if (field.enum !== undefined && field.enum.length > 0) return 'select'
  if (field.type.startsWith('refs:')) return 'references'
  if (field.type.startsWith('ref:')) return 'reference'
  switch (field.type) {
    case 'text':
      return 'textarea'
    case 'integer':
    case 'decimal':
      return 'number'
    case 'money':
      return 'money'
    case 'boolean':
      return 'checkbox'
    case 'date':
      return 'date'
    case 'datetime':
      return 'datetime'
    case 'email':
      return 'email'
    case 'phone':
      return 'tel'
    case 'url':
      return 'url'
    case 'json':
      return 'json'
    case 'file':
      return 'file'
    default:
      return 'text'
  }
}

function isNumeric(field: EntityFieldDescriptor): boolean {
  return field.type === 'integer' || field.type === 'decimal' || field.type === 'money'
}

function isSearchable(field: EntityFieldDescriptor): boolean {
  return (
    field.enum === undefined &&
    (field.type === 'string' ||
      field.type === 'text' ||
      field.type === 'email' ||
      field.type === 'phone' ||
      field.type === 'url')
  )
}

function referencedEntity(type: FieldType): string | undefined {
  if (type.startsWith('ref:')) return type.slice('ref:'.length)
  if (type.startsWith('refs:')) return type.slice('refs:'.length)
  return undefined
}

function toField(
  field: EntityFieldDescriptor,
  options: { readOnly: boolean; labelOverride?: string },
): AdminField {
  const references = referencedEntity(field.type)
  return {
    name: field.name,
    label: options.labelOverride ?? field.label ?? humanise(field.name),
    type: field.type,
    control: controlFor(field),
    required: field.required === true,
    readOnly: options.readOnly,
    numeric: isNumeric(field),
    ...(field.help === undefined ? {} : { help: field.help }),
    ...(field.enum === undefined ? {} : { options: field.enum }),
    ...(references === undefined ? {} : { references }),
  }
}

/** Declared fields plus the kernel.data system fields, deduplicated. */
export function allFields(
  descriptor: EntityDescriptor,
): readonly EntityFieldDescriptor[] {
  const declared = new Map(descriptor.fields.map((f) => [f.name, f]))
  const system = SYSTEM_FIELDS.filter((f) => !declared.has(f.name))
  const id = system.find((f) => f.name === 'id')
  const trailing = system.filter((f) => f.name !== 'id')
  return [...(id === undefined ? [] : [id]), ...descriptor.fields, ...trailing]
}

/**
 * Fold the display configuration.
 *
 * Precedence, lowest first: derived defaults → capability contributions in the
 * `entityDisplay` registry → the client's `entityDisplayConfig` slot. The
 * client wins, which is the same ordering as everywhere else in the system.
 */
export function resolveDisplayConfig(
  descriptor: EntityDescriptor,
  slots: AdminSlots = {},
): EntityDisplayConfig {
  const contributed = entityDisplay.get(descriptor.name)
  const merged: EntityDisplayConfig = {
    ...(contributed ?? {}),
    entity: descriptor.name,
    label: contributed?.label ?? entityLabel(descriptor.name),
    pluralLabel:
      contributed?.pluralLabel ??
      entityPluralLabel(descriptor.name, descriptor.plural, contributed?.label),
  }

  const slot = slots.entityDisplayConfig ?? identityEntityDisplayConfig
  return slot(descriptor.name, merged)
}

function orderedColumnFields(
  descriptor: EntityDescriptor,
  display: EntityDisplayConfig,
): readonly { field: EntityFieldDescriptor; config: ColumnConfig | undefined }[] {
  const fields = new Map(allFields(descriptor).map((f) => [f.name, f]))
  const hidden = new Set(display.hiddenFields ?? [])
  const out: { field: EntityFieldDescriptor; config: ColumnConfig | undefined }[] = []
  const claimed = new Set<string>()

  for (const config of display.columns ?? []) {
    const field = fields.get(config.field)
    if (field === undefined || hidden.has(config.field)) continue
    claimed.add(config.field)
    if (config.hidden === true) continue
    out.push({ field, config })
  }

  if (display.columns === undefined) {
    // No configuration: derive. Scalars that read well in a row, capped, so a
    // twenty-field entity does not produce a twenty-column table.
    let taken = 0
    for (const field of fields.values()) {
      if (hidden.has(field.name)) continue
      if (field.name !== 'id' && NOT_IN_LIST_BY_DEFAULT.has(field.type)) continue
      if (field.type.startsWith('refs:')) continue
      if (taken >= DEFAULT_LIST_COLUMNS) break
      out.push({ field, config: undefined })
      taken += 1
    }
    return out
  }

  // Configured columns first, then anything not mentioned, so a capability that
  // pins two columns does not accidentally hide the rest.
  for (const field of fields.values()) {
    if (claimed.has(field.name) || hidden.has(field.name)) continue
    if (field.name !== 'id' && NOT_IN_LIST_BY_DEFAULT.has(field.type)) continue
    if (field.type.startsWith('refs:')) continue
    out.push({ field, config: undefined })
  }
  return out
}

function defaultTitleField(descriptor: EntityDescriptor, display: EntityDisplayConfig): string {
  if (display.titleField !== undefined) return display.titleField
  const named = descriptor.fields.find((f) => f.name === 'name' || f.name === 'title')
  if (named !== undefined) return named.name
  const firstString = descriptor.fields.find(
    (f) => (f.type === 'string' || f.type === 'email') && f.enum === undefined,
  )
  return firstString?.name ?? 'id'
}

export interface ResolveOptions {
  readonly slots?: AdminSlots
  /** Defaults to the installed entity source. */
  readonly source?: EntitySource
}

function descriptorFor(entity: string, options: ResolveOptions): EntityDescriptor {
  const source = options.source ?? entitySource()
  const descriptor = source?.get(entity)
  if (descriptor === undefined) throw new UnknownAdminEntityError(entity)
  return descriptor
}

/** The list view for an entity. Pure. */
export function resolveListView(entity: string, options: ResolveOptions = {}): AdminListView {
  const descriptor = descriptorFor(entity, options)
  const slots = options.slots ?? {}
  const display = resolveDisplayConfig(descriptor, slots)
  const appendOnly = descriptor.appendOnly === true

  const columns: AdminColumn[] = orderedColumnFields(descriptor, display).map(
    ({ field, config }) => ({
      ...toField(field, {
        readOnly: SYSTEM_FIELD_NAMES.has(field.name),
        ...(config?.label === undefined ? {} : { labelOverride: config.label }),
      }),
      sortable: config?.sortable ?? !field.type.startsWith('ref'),
      ...(config?.width === undefined ? {} : { width: config.width }),
    }),
  )

  const hidden = new Set(display.hiddenFields ?? [])
  const declared = allFields(descriptor).filter((f) => !hidden.has(f.name))

  const filters: AdminFilter[] = declared
    .filter((field) => field.enum !== undefined || field.type === 'boolean')
    .map((field) => ({
      field: field.name,
      label: field.label ?? humanise(field.name),
      options:
        field.enum === undefined
          ? [
              { value: 'true', label: 'Yes' },
              { value: 'false', label: 'No' },
            ]
          : field.enum.map((value) => ({ value, label: humanise(value) })),
    }))

  const bulkSlot = slots.bulkAction ?? identityBulkAction
  const customSlot = slots.customAdminView ?? identityCustomAdminView

  return {
    entity: descriptor.name,
    owner: descriptor.owner,
    isClientEntity: descriptor.owner === CLIENT_OWNER,
    label: display.label ?? entityLabel(descriptor.name),
    pluralLabel: display.pluralLabel ?? entityPluralLabel(descriptor.name, descriptor.plural),
    path: `${ADMIN_BASE_PATH}/${descriptor.name}`,
    permission: ADMIN_ACCESS,
    exportPermission: ADMIN_EXPORT,
    columns,
    searchFields: declared.filter(isSearchable).map((f) => f.name),
    filters,
    defaultSort: display.defaultSort ?? { field: 'createdAt', direction: 'desc' },
    pageSize: display.pageSize ?? DEFAULT_PAGE_SIZE,
    bulkActions: bulkSlot(descriptor.name, bulkActionsFor(descriptor.name)),
    canCreate: !appendOnly,
    canEdit: !appendOnly,
    canDelete: !appendOnly,
    exportFields: declared.filter((f) => !f.type.startsWith('refs:')).map((f) => f.name),
    custom: customSlot(descriptor.name, 'list'),
  }
}

/** The detail view for an entity. Pure. */
export function resolveDetailView(
  entity: string,
  options: ResolveOptions = {},
): AdminDetailView {
  const descriptor = descriptorFor(entity, options)
  const slots = options.slots ?? {}
  const display = resolveDisplayConfig(descriptor, slots)
  const appendOnly = descriptor.appendOnly === true
  const hidden = new Set(display.hiddenFields ?? [])

  const fields = new Map(
    allFields(descriptor)
      .filter((f) => !hidden.has(f.name))
      .map((f) => [
        f.name,
        toField(f, { readOnly: SYSTEM_FIELD_NAMES.has(f.name) }),
      ]),
  )

  let sections: AdminDetailSection[]
  if (display.sections !== undefined) {
    const claimed = new Set<string>()
    sections = display.sections.map((section) => {
      const sectionFields: AdminField[] = []
      for (const name of section.fields) {
        const field = fields.get(name)
        if (field === undefined) continue
        claimed.add(name)
        sectionFields.push(field)
      }
      return { title: section.title, fields: sectionFields }
    })
    const rest = [...fields.values()].filter((f) => !claimed.has(f.name))
    if (rest.length > 0) sections = [...sections, { title: 'Other', fields: rest }]
  } else {
    // Derived default: the entity's own fields, then the system ones. Splitting
    // them is what keeps `id`/`createdAt` out of the way of the actual data.
    const own = [...fields.values()].filter((f) => !SYSTEM_FIELD_NAMES.has(f.name))
    const system = [...fields.values()].filter((f) => SYSTEM_FIELD_NAMES.has(f.name))
    sections = [
      { title: display.label ?? entityLabel(descriptor.name), fields: own },
      ...(system.length > 0 ? [{ title: 'Record', fields: system }] : []),
    ]
  }

  const customSlot = slots.customAdminView ?? identityCustomAdminView

  return {
    entity: descriptor.name,
    owner: descriptor.owner,
    isClientEntity: descriptor.owner === CLIENT_OWNER,
    label: display.label ?? entityLabel(descriptor.name),
    path: (id: string) => `${ADMIN_BASE_PATH}/${descriptor.name}/${encodeURIComponent(id)}`,
    permission: ADMIN_ACCESS,
    titleField: defaultTitleField(descriptor, display),
    sections,
    canEdit: !appendOnly,
    canDelete: !appendOnly,
    custom: customSlot(descriptor.name, 'detail'),
  }
}

/** The create/edit form for an entity. Pure. */
export function resolveFormView(
  entity: string,
  mode: 'create' | 'edit',
  options: ResolveOptions = {},
): AdminFormView {
  const descriptor = descriptorFor(entity, options)
  const slots = options.slots ?? {}
  const display = resolveDisplayConfig(descriptor, slots)
  const hidden = new Set(display.hiddenFields ?? [])
  const customSlot = slots.customAdminView ?? identityCustomAdminView

  return {
    entity: descriptor.name,
    label: display.label ?? entityLabel(descriptor.name),
    mode,
    // System fields are never editable; the repository owns them.
    fields: descriptor.fields
      .filter((f) => !hidden.has(f.name) && !SYSTEM_FIELD_NAMES.has(f.name))
      .filter((f) => !f.type.startsWith('refs:'))
      .map((f) => toField(f, { readOnly: false })),
    permission: ADMIN_ACCESS,
    custom: customSlot(descriptor.name, mode),
  }
}

/** Every view for one entity. */
export function resolveEntityViews(
  registration: AdminEntityRegistration,
  options: ResolveOptions = {},
): AdminEntityViews {
  const descriptor = descriptorFor(registration.name, options)
  return {
    registration,
    descriptor,
    display: resolveDisplayConfig(descriptor, options.slots ?? {}),
    list: resolveListView(registration.name, options),
    detail: resolveDetailView(registration.name, options),
    create: resolveFormView(registration.name, 'create', options),
    edit: resolveFormView(registration.name, 'edit', options),
  }
}

/**
 * Every registered entity, resolved.
 *
 * This is the function the spec's first smoke test is really about: if it
 * returns a list and a detail view for every registration with no per-entity
 * work, then declaring an entity in the manifest genuinely buys an admin
 * surface.
 */
export function resolveAdminConsole(options: ResolveOptions = {}): readonly AdminEntityViews[] {
  return adminEntities().map((registration) => resolveEntityViews(registration, options))
}

/** As {@link resolveAdminConsole}, loading kernel.data's registry if needed. */
export async function loadAdminConsole(
  options: Omit<ResolveOptions, 'source'> = {},
): Promise<readonly AdminEntityViews[]> {
  const source = await loadEntitySource()
  return resolveAdminConsole({ ...options, source })
}
