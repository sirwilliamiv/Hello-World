/**
 * Slot types for kernel.admin.
 *
 * Names match `slots[].signature` in catalog/kernel/kernel.admin.capability.json
 * exactly: CustomAdminViewSlot, EntityDisplayConfigSlot, BulkActionSlot.
 *
 * §4: the slot's type lives here, in the package, so a signature change in a
 * major version breaks the client's seeded stub at compile time rather than at
 * runtime.
 */

import type { ComponentType } from 'react'

import type { AdminEntityRegistration } from './entities.js'
import type { BulkAction, EntityDisplayConfig } from './registries.js'
import type { AdminUser } from './ports/access.js'
import type { EntityDescriptor } from './ports/entities.js'

export interface CustomAdminViewProps {
  readonly entity: EntityDescriptor
  readonly registration: AdminEntityRegistration
  readonly user: AdminUser
  readonly view: 'list' | 'detail' | 'create' | 'edit'
  readonly id?: string
  readonly searchParams?: Readonly<Record<string, string>>
}

/**
 * slot: customAdminView — "Replaces the generated view for a specific entity
 * with a client-specific one." Invoked when an entity's admin view is resolved.
 *
 * Returning `null` (the seeded default) keeps the generated view. Returning a
 * component replaces it *for that entity only*; every other entity keeps the
 * generic path, which is the point — a client that needs one bespoke screen
 * should not lose auto-generated CRUD for the other thirty entities.
 *
 * Seeded stub:
 *   export const customAdminView: CustomAdminViewSlot = () => null
 */
export type CustomAdminViewSlot = (
  entity: string,
  view: 'list' | 'detail' | 'create' | 'edit',
) => ComponentType<CustomAdminViewProps> | null

/**
 * slot: entityDisplayConfig — "Client-specific column selection, ordering, and
 * labelling." Invoked when admin columns and labels are resolved.
 *
 * Receives the config already folded from capability contributions, so a client
 * can amend rather than restate.
 *
 * Seeded stub:
 *   export const entityDisplayConfig: EntityDisplayConfigSlot = (_, config) => config
 */
export type EntityDisplayConfigSlot = (
  entity: string,
  config: EntityDisplayConfig,
) => EntityDisplayConfig

/**
 * slot: bulkAction — "Client-specific bulk operations." Invoked when the bulk
 * action menu is built.
 *
 * Receives the capability-contributed actions for the entity and returns the
 * final list, so a client can add, remove or reorder.
 *
 * Seeded stub:
 *   export const bulkAction: BulkActionSlot = (_, actions) => actions
 */
export type BulkActionSlot = (
  entity: string,
  actions: readonly BulkAction[],
) => readonly BulkAction[]

export const identityCustomAdminView: CustomAdminViewSlot = () => null
export const identityEntityDisplayConfig: EntityDisplayConfigSlot = (_entity, config) => config
export const identityBulkAction: BulkActionSlot = (_entity, actions) => actions

/** The three slots, as the console receives them. */
export interface AdminSlots {
  readonly customAdminView?: CustomAdminViewSlot
  readonly entityDisplayConfig?: EntityDisplayConfigSlot
  readonly bulkAction?: BulkActionSlot
}
