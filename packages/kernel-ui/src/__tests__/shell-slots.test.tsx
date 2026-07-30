/**
 * The shell's two slots: `logo` and `dashboardWidgets`.
 *
 * schemas/capability.schema.json, `$defs.slot.signature`: every slot context
 * exposes `proceed()`, returning what the capability would have done with no
 * slot implemented. internal/render/render.go seeds exactly this body, so the
 * stubs below are the literal generated text.
 *
 * Both call sites are server components. There is no react-dom and no DOM in
 * this workspace, so the assertions are made on the element trees they return —
 * which is where the slot's effect actually lands.
 */

import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { dashboardWidgets, registerDashboardWidget } from '../dashboard.js'
import type { DashboardWidget, DashboardWidgetProps } from '../dashboard.js'
import {
  configureUiSlots,
  dashboardWidgetsContext,
  identityDashboardWidgets,
  identityLogo,
  logoContext,
  resetUiSlots,
  type DashboardWidgetsSlot,
  type LogoSlot,
} from '../slots.js'
import { AppShell } from '../shell/AppShell.js'
import { Dashboard } from '../shell/Dashboard.js'

const PRODUCT = 'Acme'

function Body({ widget }: DashboardWidgetProps) {
  return <div>{widget.title}</div>
}

function widget(id: string, order?: number): DashboardWidget {
  return {
    id,
    title: id,
    component: Body,
    ...(order === undefined ? {} : { order }),
  }
}

/** The first element in a tree carrying `className`. */
function findByClass(node: ReactNode, className: string): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByClass(child, className)
      if (found !== null) return found
    }
    return null
  }
  if (!isValidElement(node)) return null
  const props = node.props as { className?: string; children?: ReactNode }
  if (props.className === className) return node
  return findByClass(props.children ?? null, className)
}

function brandOf(tree: ReactNode): ReactNode {
  const brand = findByClass(tree, 'fui-shell__brand')
  expect(brand).not.toBeNull()
  // <div class="fui-shell__brand"><a …>{mark}</a></div>
  const link = (brand?.props as { children?: ReactNode }).children
  expect(isValidElement(link)).toBe(true)
  return (link as ReactElement<{ children?: ReactNode }>).props.children
}

function widgetIdsOf(tree: ReactElement): string[] {
  const grid = findByClass(tree, 'fui-dashboard')
  if (grid === null) return []
  const children = (grid.props as { children?: ReactNode }).children
  const list = Array.isArray(children) ? children : [children]
  return list.filter(isValidElement).map((child) => String(child.key))
}

beforeEach(() => {
  dashboardWidgets.clear()
  resetUiSlots()
})

afterEach(() => {
  dashboardWidgets.clear()
  resetUiSlots()
})

describe('the logo slot', () => {
  it('proceed() returns the shell brand mark: the manifest image, or a wordmark', () => {
    const wordmark = logoContext({
      product: PRODUCT,
      variant: 'light',
      logoSrc: undefined,
    }).proceed() as ReactElement<{ children?: ReactNode }>
    expect(wordmark.type).toBe('span')
    expect(wordmark.props.children).toBe(PRODUCT)

    const image = logoContext({
      product: PRODUCT,
      variant: 'light',
      logoSrc: '/brand/acme.svg',
    }).proceed() as ReactElement<{ src: string; alt: string }>
    expect(image.type).toBe('img')
    expect(image.props.src).toBe('/brand/acme.svg')
    expect(image.props.alt).toBe(PRODUCT)
  })

  it('the seeded stub renders the header an unslotted product renders', async () => {
    const logo: LogoSlot = async (ctx) => {
      return ctx.proceed()
    }
    const withStub = brandOf(
      await AppShell({ product: PRODUCT, logoSrc: '/brand/acme.svg', children: null, logo }),
    ) as ReactElement<{ src: string }>
    const without = brandOf(
      await AppShell({ product: PRODUCT, logoSrc: '/brand/acme.svg', children: null }),
    ) as ReactElement<{ src: string }>

    expect(withStub.type).toBe(without.type)
    expect(withStub.props.src).toBe(without.props.src)
    expect(brandOf(await AppShell({ product: PRODUCT, children: null, logo: identityLogo }))).toEqual(
      brandOf(await AppShell({ product: PRODUCT, children: null })),
    )
  })

  it('a slot returning something else changes the brand mark', async () => {
    const logo: LogoSlot = (ctx) => <em data-variant={ctx.variant}>{ctx.product} Ltd</em>
    const mark = brandOf(
      await AppShell({ product: PRODUCT, logoSrc: '/brand/acme.svg', children: null, logo }),
    ) as ReactElement<{ 'data-variant': string; children: ReactNode }>

    expect(mark.type).toBe('em')
    expect(mark.props['data-variant']).toBe('light')
    // The manifest image the default would have rendered is gone.
    expect(mark.props.children).toEqual([PRODUCT, ' Ltd'])
  })

  it('is invoked from the slot registry, not only by prop', async () => {
    // The `logo` slot had no call site reachable from the generated layout
    // before: templates/_product/layout.tsx.tmpl renders <AppShell product=…>
    // and passes no logo, so a client could seed one and watch nothing happen.
    configureUiSlots({ logo: (ctx) => <b>{ctx.product}</b> })
    const mark = brandOf(await AppShell({ product: PRODUCT, children: null })) as ReactElement
    expect(mark.type).toBe('b')
  })
})

describe('the dashboardWidgets slot', () => {
  it('proceed() returns the registry contents in registry order', () => {
    registerDashboardWidget(widget('b', 10))
    registerDashboardWidget(widget('a', 20))
    const ctx = dashboardWidgetsContext(dashboardWidgets.all())

    expect(ctx.proceed().map((w) => w.id)).toEqual(['b', 'a'])
    // A copy: a client is expected to filter and rearrange what it gets back.
    expect(ctx.proceed()).not.toBe(ctx.widgets)
  })

  it('the seeded stub composes the dashboard an unslotted product composes', async () => {
    registerDashboardWidget(widget('kernel.work:tasks', 10))
    registerDashboardWidget(widget('pay.invoices:overdue', 20))

    const arrange: DashboardWidgetsSlot = async (ctx) => {
      return ctx.proceed()
    }
    expect(widgetIdsOf(await Dashboard({ arrange }))).toEqual(
      widgetIdsOf(await Dashboard({})),
    )
    expect(widgetIdsOf(await Dashboard({ arrange: identityDashboardWidgets }))).toEqual([
      'kernel.work:tasks',
      'pay.invoices:overdue',
    ])
  })

  it('a slot returning something else changes the dashboard', async () => {
    registerDashboardWidget(widget('kernel.work:tasks', 10))
    registerDashboardWidget(widget('pay.invoices:overdue', 20))

    const arrange: DashboardWidgetsSlot = (ctx) =>
      [...ctx.proceed()].reverse().filter((w) => w.id !== 'kernel.work:tasks')
    expect(widgetIdsOf(await Dashboard({ arrange }))).toEqual(['pay.invoices:overdue'])
  })

  it('is invoked from the slot registry, not only by prop', async () => {
    registerDashboardWidget(widget('kernel.work:tasks', 10))
    configureUiSlots({ dashboardWidgets: (ctx) => ctx.proceed().slice(0, 0) })
    expect(widgetIdsOf(await Dashboard({}))).toEqual([])
  })
})
