/**
 * Slot types for kernel.ui.
 *
 * ARCHITECTURE §4: "The slot's *type* lives in the npm package and therefore
 * upgrades with the package. If a major version changes a slot signature, the
 * client's implementation fails to compile — which is exactly the outcome we
 * want, because it is loud, local, and fixable."
 *
 * Names match `slots[].signature` in catalog/kernel/kernel.ui.capability.json
 * exactly: ThemeSlot, LogoSlot, NavigationOrderSlot, DashboardWidgetsSlot.
 * Forge seeds a stub per slot into src/slots/kernel.ui/ on first apply.
 */

import type { ComponentType } from 'react'

import type { DashboardWidget } from './dashboard.js'
import type { NavigationEntry } from './navigation.js'
import type { TokenSet } from './tokens.js'

/**
 * slot: theme — "Client-specific token overrides beyond what manifest branding
 * expresses." Invoked at token resolution.
 *
 * Seeded stub:
 *   export const theme: ThemeSlot = (tokens) => tokens
 */
export type ThemeSlot = (tokens: TokenSet) => TokenSet

/**
 * slot: logo — "Client logo component, for cases a static asset cannot
 * express." Invoked when the shell renders the brand mark.
 *
 * Seeded stub:
 *   export const logo: LogoSlot = null
 * (null means "use branding.logo from the manifest".)
 */
export interface LogoSlotProps {
  readonly product: string
  readonly variant: 'light' | 'dark'
}
export type LogoSlot = ComponentType<LogoSlotProps> | null

/**
 * slot: navigationOrder — "Client-specific ordering and grouping of registered
 * navigation entries." Invoked when the nav registry is resolved.
 *
 * The generated navigation.ts calls this with the graph's nav items and
 * registers whatever comes back, so returning a subset is how a client hides an
 * entry, and returning a reordered array is how it reorders one.
 *
 * Seeded stub:
 *   export const navigationOrder: NavigationOrderSlot = (items) => items
 */
export type NavigationOrderSlot = (
  items: readonly NavigationEntry[],
) => readonly NavigationEntry[]

/**
 * slot: dashboardWidgets — "Client-specific widget selection and arrangement."
 * Invoked when the dashboard is composed.
 *
 * Seeded stub:
 *   export const dashboardWidgets: DashboardWidgetsSlot = (widgets) => widgets
 */
export type DashboardWidgetsSlot = (
  widgets: readonly DashboardWidget[],
) => readonly DashboardWidget[]

/** Identity implementations, used when a client has not seeded a slot. */
export const identityTheme: ThemeSlot = (tokens) => tokens
export const identityNavigationOrder: NavigationOrderSlot = (items) => items
export const identityDashboardWidgets: DashboardWidgetsSlot = (widgets) => widgets
