/**
 * Slot types for kernel.admin.
 *
 * Names match `slots[].signature` in catalog/kernel/kernel.admin.capability.json
 * exactly: CustomAdminViewSlot, EntityDisplayConfigSlot, BulkActionSlot.
 *
 * §4: the slot's type lives here, in the package, so a signature change in a
 * major version breaks the client's seeded stub at compile time rather than at
 * runtime.
 *
 * Each slot takes one context, and every context carries `proceed()` returning
 * exactly what the generic path does with no slot implemented
 * (schemas/capability.schema.json, `$defs.slot.signature`). That is what makes
 * the seeded stub a one-liner —
 *
 *     export const entityDisplayConfig: EntityDisplayConfigSlot = async (ctx) => {
 *       return ctx.proceed()
 *     }
 *
 * — and it is why the display slot is handed the columns the resolver *derived*
 * rather than the empty configuration it started from: a client amending one
 * column should not have to reconstruct the other nine to keep them.
 *
 * Every slot may return a promise, because the stub Forge seeds is `async`
 * (internal/render/render.go) and because a client's rule can need a lookup. The
 * resolvers are therefore async; they are still pure functions of (entity
 * registry, display registry, slots), which is what the generic-path tests
 * assert.
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

export interface CustomAdminViewContext {
  readonly entity: string
  readonly view: 'list' | 'detail' | 'create' | 'edit'
  /**
   * Keep the generated view. There is no bespoke screen with no slot
   * implemented, and that is the whole value of the generic path.
   */
  proceed(): null
}

/**
 * slot: customAdminView — "Replaces the generated view for a specific entity
 * with a client-specific one." Invoked when an entity's admin view is resolved.
 *
 * Returning `ctx.proceed()` keeps the generated view. Returning a component
 * replaces it *for that entity only*; every other entity keeps the generic
 * path, which is the point — a client that needs one bespoke screen should not
 * lose auto-generated CRUD for the other thirty entities.
 *
 * Seeded stub:
 *   export const customAdminView: CustomAdminViewSlot = async (ctx) => ctx.proceed()
 */
export type CustomAdminViewSlot = (
  ctx: CustomAdminViewContext,
) => ComponentType<CustomAdminViewProps> | null | Promise<ComponentType<CustomAdminViewProps> | null>

export interface EntityDisplayConfigContext {
  readonly entity: string
  /**
   * What the generic path resolves on its own: the derived defaults, the
   * `entityDisplay` contributions folded over them, and — materialised, not left
   * `undefined` — the columns the resolver derived, in the order it derived
   * them. Amend this rather than restating it.
   */
  readonly config: EntityDisplayConfig
  proceed(): EntityDisplayConfig
}

/**
 * slot: entityDisplayConfig — "Client-specific column selection, ordering, and
 * labelling." Invoked when admin columns and labels are resolved.
 *
 * Seeded stub:
 *   export const entityDisplayConfig: EntityDisplayConfigSlot = async (ctx) => ctx.proceed()
 */
export type EntityDisplayConfigSlot = (
  ctx: EntityDisplayConfigContext,
) => EntityDisplayConfig | Promise<EntityDisplayConfig>

export interface BulkActionSlotContext {
  readonly entity: string
  /** The capability-contributed actions applicable to this entity, in id order. */
  readonly actions: readonly BulkAction[]
  proceed(): readonly BulkAction[]
}

/**
 * slot: bulkAction — "Client-specific bulk operations." Invoked when the bulk
 * action menu is built.
 *
 * Receives the capability-contributed actions for the entity and returns the
 * final list, so a client can add, remove or reorder.
 *
 * Seeded stub:
 *   export const bulkAction: BulkActionSlot = async (ctx) => ctx.proceed()
 */
export type BulkActionSlot = (
  ctx: BulkActionSlotContext,
) => readonly BulkAction[] | Promise<readonly BulkAction[]>

export const identityCustomAdminView: CustomAdminViewSlot = (ctx) => ctx.proceed()
export const identityEntityDisplayConfig: EntityDisplayConfigSlot = (ctx) => ctx.proceed()
export const identityBulkAction: BulkActionSlot = (ctx) => ctx.proceed()

/** The three slots, as the console receives them. */
export interface AdminSlots {
  readonly customAdminView?: CustomAdminViewSlot
  readonly entityDisplayConfig?: EntityDisplayConfigSlot
  readonly bulkAction?: BulkActionSlot
}
