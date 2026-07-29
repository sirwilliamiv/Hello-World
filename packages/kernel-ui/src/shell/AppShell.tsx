/**
 * AppShell — the application chrome every product renders.
 *
 * Call site is generated — templates/_product/layout.tsx.tmpl:
 *
 *   import { AppShell } from '@forge/kernel-ui'
 *   import '@/generated/kernel.ui/tokens.css'
 *   import '@/generated/kernel.ui/navigation'
 *   ...
 *   <AppShell product="Acme">{children}</AppShell>
 *
 * So `product` and `children` are the only required props, and this module must
 * pull in the package stylesheets itself — the layout imports the *generated*
 * tokens file, not this package's defaults, and it does so after this import so
 * that its `:root` block wins on source order. That ordering is the whole
 * branding mechanism; see src/styles/tokens.css.
 *
 * An async server component. It renders no interactive state of its own; the
 * one client boundary is ToastProvider, so a capability can raise a toast from
 * anywhere without every page becoming a client tree.
 */

import type { ReactNode } from 'react'


import '../styles/tokens.css'
import '../styles/components.css'

import { ToastProvider } from '../components/Toast.js'
import type { NavigationPermissionResolver } from '../navigation.js'
import { logoContext, uiSlots, type LogoSlot } from '../slots.js'
import { Nav } from './Nav.js'

export interface AppShellProps {
  /** The product name from the manifest. */
  readonly product: string
  readonly children: ReactNode
  /**
   * The client's `logo` slot. Omitted falls back to whatever `configureUiSlots`
   * installed, and then to the manifest logo image or the product name as a
   * wordmark — which is what an unbranded product should look like.
   */
  readonly logo?: LogoSlot
  /** Path to a static logo image, from `branding.logo` in the manifest. */
  readonly logoSrc?: string
  /** Current pathname, for nav highlighting. */
  readonly currentPath?: string
  /** Permission resolver override. Normally installed by the access capability. */
  readonly can?: NavigationPermissionResolver
  readonly groupLabels?: Readonly<Record<string, string>>
  /** Rendered on the right of the header — account menu, environment badge. */
  readonly headerActions?: ReactNode
  /** Rendered on the left of the header — breadcrumbs, page title. */
  readonly headerContent?: ReactNode
}

/**
 * The `logo` slot's call site.
 *
 * `ctx.proceed()` renders the shell's own mark — the manifest logo image, or
 * the product name as a wordmark — so the seeded stub produces exactly the
 * header an unslotted product has.
 */
async function brandMark(
  product: string,
  logo: LogoSlot | undefined,
  logoSrc: string | undefined,
): Promise<ReactNode> {
  const context = logoContext({ product, variant: 'light', logoSrc })
  return logo === undefined ? context.proceed() : await logo(context)
}

export async function AppShell({
  product,
  children,
  logo,
  logoSrc,
  currentPath,
  can,
  groupLabels,
  headerActions,
  headerContent,
}: AppShellProps) {
  const brand = await brandMark(product, logo ?? uiSlots().logo, logoSrc)

  return (
    <ToastProvider>
      <div className="fui-shell">
        <div className="fui-shell__brand">
          <a
            href="/"
            className="fui-nav__link"
            style={{ padding: 0, color: 'inherit', textDecoration: 'none' }}
          >
            {brand}
          </a>
        </div>

        <header className="fui-shell__header">
          <div>{headerContent}</div>
          <div>{headerActions}</div>
        </header>

        <Nav
          {...(currentPath === undefined ? {} : { currentPath })}
          {...(can === undefined ? {} : { can })}
          {...(groupLabels === undefined ? {} : { groupLabels })}
        />

        <main className="fui-shell__main">
          <div className="fui-shell__content">{children}</div>
        </main>
      </div>
    </ToastProvider>
  )
}
