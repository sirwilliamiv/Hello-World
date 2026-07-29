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
 * Forge seeds a stub per slot into src/slots/kernel.ui/ on first apply, and
 * every stub has the same body (internal/render/render.go):
 *
 *     export const navigationOrder: NavigationOrderSlot = async (ctx) => {
 *       return ctx.proceed()
 *     }
 *
 * So every slot here takes one context object, and that context exposes
 * `proceed()` returning exactly what kernel.ui does with the slot unimplemented
 * (schemas/capability.schema.json, `$defs.slot.signature`).
 */

import { createElement, type ReactNode } from 'react'

import type { DashboardWidget } from './dashboard.js'
import type { NavigationEntry } from './navigation.js'
import type { TokenOverrides, TokenSet } from './tokens.js'

/* ---------------------------------------------------------------------- theme */

export interface ThemeContext {
  /** `branding.tokens` from the manifest, before the defaults are folded in. */
  readonly overrides: TokenOverrides
  /** Package defaults with manifest branding applied over them. */
  readonly tokens: TokenSet
  /**
   * The resolved token set with no client theme: package defaults, then
   * manifest branding. Returning it unchanged is what an unslotted product
   * renders.
   */
  proceed(): TokenSet
}

/**
 * slot: theme — "Client-specific token overrides beyond what manifest branding
 * expresses." Invoked at token resolution, by `resolveThemeTokens`.
 */
export type ThemeSlot = (ctx: ThemeContext) => TokenSet | Promise<TokenSet>

/* ----------------------------------------------------------------------- logo */

/** Props a client's logo component receives, when it writes one. */
export interface LogoSlotProps {
  readonly product: string
  readonly variant: 'light' | 'dark'
}

export interface LogoContext {
  readonly product: string
  readonly variant: 'light' | 'dark'
  /** `branding.logo` from the manifest, when the client set one. */
  readonly logoSrc: string | undefined
  /**
   * The shell's own brand mark: the manifest logo image when there is one, and
   * the product name as a wordmark when there is not. Exactly what the header
   * renders with no slot implemented.
   */
  proceed(): ReactNode
}

/**
 * slot: logo — "Client logo component, for cases a static asset cannot
 * express." Invoked when the shell renders the brand mark.
 *
 * Return a rendered mark, usually a client component:
 *   `(ctx) => <SeasonalLogo product={ctx.product} variant={ctx.variant} />`
 */
export type LogoSlot = (ctx: LogoContext) => ReactNode | Promise<ReactNode>

/* -------------------------------------------------------------- navigationOrder */

export interface NavigationOrderContext {
  /** The graph's nav entries, in their declared order. */
  readonly entries: readonly NavigationEntry[]
  /**
   * The entries in their declared order — the order the resolved graph emits,
   * which is what the shell shows with no slot implemented.
   */
  proceed(): NavigationEntry[]
}

/**
 * slot: navigationOrder — "Client-specific ordering and grouping of registered
 * navigation entries." Invoked when the nav registry is resolved, by
 * `registerNavItems`, which registers whatever comes back and shows it in that
 * order. Returning a subset is how a client hides an entry; returning a
 * reordered array is how it reorders one.
 */
export type NavigationOrderSlot = (
  ctx: NavigationOrderContext,
) => readonly NavigationEntry[] | Promise<readonly NavigationEntry[]>

/* ------------------------------------------------------------ dashboardWidgets */

export interface DashboardWidgetsContext {
  /** Every registered widget, in registry order: (order, id). */
  readonly widgets: readonly DashboardWidget[]
  /** The registry's contents in registry order — the default dashboard. */
  proceed(): DashboardWidget[]
}

/**
 * slot: dashboardWidgets — "Client-specific widget selection and arrangement."
 * Invoked when the dashboard is composed, by `<Dashboard />`.
 */
export type DashboardWidgetsSlot = (
  ctx: DashboardWidgetsContext,
) => readonly DashboardWidget[] | Promise<readonly DashboardWidget[]>

/* ---------------------------------------------------------- context builders */

/**
 * The call sites build their context through these, so each `proceed()` is
 * defined once and cannot drift from the path taken when the slot is absent.
 */

export function themeContext(overrides: TokenOverrides, tokens: TokenSet): ThemeContext {
  return { overrides, tokens, proceed: () => tokens }
}

export function logoContext(input: Omit<LogoContext, 'proceed'>): LogoContext {
  return {
    ...input,
    proceed: (): ReactNode =>
      input.logoSrc === undefined
        ? createElement('span', null, input.product)
        : createElement('img', { src: input.logoSrc, alt: input.product, height: 24 }),
  }
}

export function navigationOrderContext(
  entries: readonly NavigationEntry[],
): NavigationOrderContext {
  return { entries, proceed: () => [...entries] }
}

export function dashboardWidgetsContext(
  widgets: readonly DashboardWidget[],
): DashboardWidgetsContext {
  return { widgets, proceed: () => [...widgets] }
}

/* ------------------------------------------------------------------ defaults */

/**
 * Identity implementations, used when a client has not seeded a slot. Byte for
 * byte what the seeded stub does.
 */
export const identityTheme: ThemeSlot = (ctx) => ctx.proceed()
export const identityLogo: LogoSlot = (ctx) => ctx.proceed()
export const identityNavigationOrder: NavigationOrderSlot = (ctx) => ctx.proceed()
export const identityDashboardWidgets: DashboardWidgetsSlot = (ctx) => ctx.proceed()

/* -------------------------------------------------------------- the boot seam */

/**
 * What `src/slots/kernel.ui/` exports. Every slot is optional: an absent slot
 * is the default path, not a hole.
 */
export interface UiSlots {
  readonly theme?: ThemeSlot | undefined
  readonly logo?: LogoSlot | undefined
  readonly navigationOrder?: NavigationOrderSlot | undefined
  readonly dashboardWidgets?: DashboardWidgetsSlot | undefined
}

let slots: UiSlots = {}

/**
 * Wire the client's slot implementations, once at boot:
 *
 *     import * as slots from '@/slots/kernel.ui'
 *     configureUiSlots(slots)
 *
 * kernel.ui's managed templates are the token stylesheet and the navigation
 * registration, neither of which can pass a slot to a React tree, so — exactly
 * as kernel.access does with `configureAccess` — the host installs them here.
 * `<AppShell>` and `<Dashboard>` still accept a slot by prop, which wins over
 * whatever is installed.
 */
export function configureUiSlots(implementations: UiSlots): void {
  slots = { ...slots, ...implementations }
}

export function uiSlots(): UiSlots {
  return slots
}

/** Test helper, and the reset a preview surface needs between renders. */
export function resetUiSlots(): void {
  slots = {}
}
