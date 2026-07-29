/**
 * The `dashboardWidgets` registry.
 *
 * Spec exposes: registry `dashboardWidgets` — "Widgets contributed to the
 * default dashboard." Capabilities contribute; the client's
 * `dashboardWidgets` slot selects and arranges.
 */

import type { ComponentType } from 'react'

import { createRegistry, type Registry } from './registry.js'

export type WidgetSpan = 1 | 2 | 3 | 4

export interface DashboardWidgetProps {
  readonly widget: DashboardWidget
}

export interface DashboardWidget {
  /** Unique across the graph. Conventionally `<capability>:<name>`. */
  readonly id: string
  readonly title: string
  /** Columns spanned on a 4-column grid. */
  readonly span?: WidgetSpan
  readonly order?: number
  /** Hidden unless the active access capability grants this permission. */
  readonly permission?: string
  readonly owner?: string
  /**
   * The widget body. A server component is expected — a dashboard widget that
   * needs interactivity should be a client component imported by this one, not
   * a reason to make the whole dashboard a client tree.
   */
  readonly component: ComponentType<DashboardWidgetProps>
}

export const dashboardWidgets: Registry<DashboardWidget> = createRegistry<DashboardWidget>({
  name: 'kernel.ui:dashboardWidgets',
  key: (widget) => widget.id,
  sort: (a, b) => {
    const order = (a.order ?? 0) - (b.order ?? 0)
    return order === 0 ? a.id.localeCompare(b.id) : order
  },
})

export function registerDashboardWidget(widget: DashboardWidget): () => void {
  return dashboardWidgets.register(widget)
}
