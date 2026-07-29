/**
 * The `entityDisplay` and `bulkActions` registries.
 *
 * Spec exposes:
 *   registry entityDisplay — "Per-entity display configuration contributed by
 *     capabilities: column selection, labels, and detail layout."
 *   registry bulkActions  — "Bulk actions contributed by capabilities and
 *     surfaced on the relevant entity list."
 *
 * A capability contributes through `registers: [{ registry:
 * "kernel.admin:entityDisplay", entries: [...] }]` (§9.3). A *client*
 * contributes through the `entityDisplayConfig` and `bulkAction` slots, which
 * are applied after these — see resolve.ts for the precedence.
 */

import { createRegistry, type Registry } from '@forge/kernel-ui'

import type { AdminUser } from './ports/access.js'
import type { Row } from './ports/repository.js'

export type ColumnAlign = 'start' | 'end'

export interface ColumnConfig {
  readonly field: string
  readonly label?: string
  readonly align?: ColumnAlign
  readonly width?: string
  /** Exclude from the list view without excluding from detail or export. */
  readonly hidden?: boolean
  readonly sortable?: boolean
}

export interface DetailSectionConfig {
  readonly title: string
  readonly fields: readonly string[]
}

export interface EntityDisplayConfig {
  /** Entity name. Also the registry key. */
  readonly entity: string
  /** Human label; defaults to the entity name split on case. */
  readonly label?: string
  readonly pluralLabel?: string
  /** Column order for the list view. Unlisted fields follow, in schema order. */
  readonly columns?: readonly ColumnConfig[]
  /** Fields never shown in list, detail or export. */
  readonly hiddenFields?: readonly string[]
  /** Field whose value titles a detail view. Defaults to the first string field. */
  readonly titleField?: string
  readonly sections?: readonly DetailSectionConfig[]
  readonly defaultSort?: { readonly field: string; readonly direction: 'asc' | 'desc' }
  readonly pageSize?: number
  /** Contributing capability id, for debugging a fleet. */
  readonly owner?: string
}

export const entityDisplay: Registry<EntityDisplayConfig> = createRegistry<EntityDisplayConfig>({
  name: 'kernel.admin:entityDisplay',
  key: (config) => config.entity,
  sort: (a, b) => a.entity.localeCompare(b.entity),
})

export function registerEntityDisplay(config: EntityDisplayConfig): () => void {
  return entityDisplay.register(config)
}

export interface BulkActionContext {
  readonly user: AdminUser
  readonly entity: string
}

export interface BulkActionResult {
  readonly affected: number
  readonly message?: string
}

export interface BulkAction {
  /** Unique across the graph. Conventionally `<capability>:<verb>`. */
  readonly id: string
  readonly label: string
  /** Entity names this action applies to. `'*'` means every entity. */
  readonly entities: readonly string[] | '*'
  /** Permission required in addition to `admin.access`. */
  readonly permission?: string
  readonly destructive?: boolean
  /** Ask before running. Defaults to `destructive`. */
  readonly confirm?: boolean
  readonly owner?: string
  run(ids: readonly string[], context: BulkActionContext): Promise<BulkActionResult>
}

export const bulkActions: Registry<BulkAction> = createRegistry<BulkAction>({
  name: 'kernel.admin:bulkActions',
  key: (action) => action.id,
  sort: (a, b) => a.id.localeCompare(b.id),
})

export function registerBulkAction(action: BulkAction): () => void {
  return bulkActions.register(action)
}

/** Actions applicable to one entity, including the `'*'` ones. */
export function bulkActionsFor(entity: string): readonly BulkAction[] {
  return bulkActions
    .all()
    .filter((action) => action.entities === '*' || action.entities.includes(entity))
}

export type { Row }
