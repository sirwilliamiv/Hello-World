/**
 * @forge/kernel-admin
 *
 * Every entity in the system, including manifest-declared client entities, gets
 * an admin surface automatically. This is the largest single reason
 * client-specific entities belong in the manifest rather than in code:
 * declaring one buys admin, audit, search, permissions, and reporting with no
 * further work.
 *
 * Spec: catalog/kernel/kernel.admin.capability.json
 */

// Imported by src/generated/kernel.admin/entities.ts.
export {
  CLIENT_OWNER,
  adminEntities,
  adminEntity,
  clientEntities,
  isAdminEntity,
  registerAdminEntity,
  resetAdminEntities,
} from './entities.js'
export type { AdminEntityRegistration } from './entities.js'

// exposes.ui_surface: AdminConsole
export { AdminConsole } from './console/AdminConsole.js'
export type { AdminConsoleProps } from './console/AdminConsole.js'
export { EntityListView } from './console/EntityListView.js'
export type { EntityListViewProps } from './console/EntityListView.js'
export { EntityDetailView } from './console/EntityDetailView.js'
export type { EntityDetailViewProps } from './console/EntityDetailView.js'
export { EntityFormView } from './console/EntityFormView.js'
export type { EntityFormViewProps } from './console/EntityFormView.js'

// exposes.registry: entityDisplay, bulkActions
export {
  bulkActions,
  bulkActionsFor,
  entityDisplay,
  registerBulkAction,
  registerEntityDisplay,
} from './registries.js'
export type {
  BulkAction,
  BulkActionContext,
  BulkActionResult,
  ColumnAlign,
  ColumnConfig,
  DetailSectionConfig,
  EntityDisplayConfig,
} from './registries.js'

// The generic resolution path — pure, and the thing the smoke tests assert.
export {
  ADMIN_BASE_PATH,
  UnknownAdminEntityError,
  allFields,
  controlFor,
  loadAdminConsole,
  resolveAdminConsole,
  resolveDetailView,
  resolveDisplayConfig,
  resolveEntityViews,
  resolveFormView,
  resolveListView,
} from './resolve.js'
export type {
  AdminColumn,
  AdminControl,
  AdminDetailSection,
  AdminDetailView,
  AdminEntityViews,
  AdminField,
  AdminFilter,
  AdminFormView,
  AdminListView,
  ResolveOptions,
} from './resolve.js'

// Permission gating. Every admin surface goes through these.
export {
  AdminForbiddenError,
  AdminNotFoundError,
  forbiddenResponse,
  guarded,
  mayAdmin,
  notFoundResponse,
  requireAdmin,
} from './guard.js'

// Routes.
export { createAdminRouteHandlers, handleAdminRequest } from './routes.js'
export type { AdminMethod, AdminRequest, AdminRouteHandlerOptions } from './routes.js'

// Export.
export { exportResponse, toCsv } from './export.js'
export type { ExportOptions } from './export.js'

// Derived validation.
export { fieldSchema, formSchema } from './schema.js'

// Slot types. Names match slots[].signature in the spec exactly.
export {
  identityBulkAction,
  identityCustomAdminView,
  identityEntityDisplayConfig,
} from './slots.js'
export type {
  AdminSlots,
  BulkActionSlot,
  CustomAdminViewProps,
  CustomAdminViewSlot,
  EntityDisplayConfigSlot,
} from './slots.js'

// Dependency ports. Exported so the generated wiring — and tests — can install
// concrete implementations without kernel.admin reaching into internals.
export { ADMIN_ACCESS, ADMIN_EXPORT, can, setPermissionChecker } from './ports/access.js'
export type { AdminUser, CanFn, ResourceRef } from './ports/access.js'
export { entitySource, loadEntitySource, setEntitySource } from './ports/entities.js'
export type {
  EntityDescriptor,
  EntityFieldDescriptor,
  EntitySource,
  FieldType,
  ScalarFieldType,
} from './ports/entities.js'
export { repositoryFor, setRepositoryFactory } from './ports/repository.js'
export type {
  FindManyOptions,
  FindManyResult,
  Repository,
  RepositoryFactory,
  Row,
} from './ports/repository.js'

// Labels, exported because a bespoke admin view should title things the way the
// generated ones do.
export { entityLabel, entityPluralLabel, humanise, pluralise } from './labels.js'
