/**
 * Dashboard — the composed default landing surface.
 *
 * Reads the `dashboardWidgets` registry, applies the client's
 * `dashboardWidgets` slot, and lays the result out on a four-column grid.
 * A capability contributes a widget by registering it; it never touches this
 * file, and a client rearranges by editing its seeded slot, not this file.
 */

import { dashboardWidgets, type DashboardWidget } from '../dashboard.js'
import type { NavigationPermissionResolver } from '../navigation.js'
import {
  dashboardWidgetsContext,
  uiSlots,
  type DashboardWidgetsSlot,
} from '../slots.js'

export interface DashboardProps {
  /**
   * The client's `dashboardWidgets` slot. Defaults to whatever
   * `configureUiSlots` installed, and to the registry order when nothing is
   * installed.
   */
  readonly arrange?: DashboardWidgetsSlot
  /** Permission resolver for widgets declaring one. */
  readonly can?: NavigationPermissionResolver
  readonly empty?: React.ReactNode
}

async function visible(
  widgets: readonly DashboardWidget[],
  can: NavigationPermissionResolver | undefined,
): Promise<readonly DashboardWidget[]> {
  const out: DashboardWidget[] = []
  for (const widget of widgets) {
    if (widget.permission === undefined) {
      out.push(widget)
      continue
    }
    // Fail closed, exactly as the nav does.
    if (can !== undefined && (await can(widget.permission))) out.push(widget)
  }
  return out
}

export async function Dashboard({
  arrange = uiSlots().dashboardWidgets,
  can,
  empty = 'No widgets have been registered.',
}: DashboardProps) {
  const context = dashboardWidgetsContext(dashboardWidgets.all())
  const arranged = arrange === undefined ? context.proceed() : await arrange(context)
  const widgets = await visible(arranged, can)

  if (widgets.length === 0) {
    return <div className="fui-table__empty">{empty}</div>
  }

  return (
    <div className="fui-dashboard">
      {widgets.map((widget) => {
        const Body = widget.component
        return (
          <div
            key={widget.id}
            className={`fui-dashboard__widget--${widget.span ?? 2}`}
          >
            <Body widget={widget} />
          </div>
        )
      })}
    </div>
  )
}
