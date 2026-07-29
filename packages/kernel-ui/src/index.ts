/**
 * @forge/kernel-ui
 *
 * The literal design system inside the product system. Capabilities never ship
 * their own styles; they register surfaces into the shell and consume tokens.
 * Branding a client is a token change and nothing else, which is what keeps a
 * client's look out of the merge path entirely.
 *
 * Spec: catalog/kernel/kernel.ui.capability.json
 */

// exposes.component: primitives
export { Button } from './components/Button.js'
export type { ButtonProps, ButtonSize, ButtonVariant } from './components/Button.js'
export { Card } from './components/Card.js'
export type { CardProps } from './components/Card.js'
export { DataGrid } from './components/DataGrid.js'
export type { DataGridBulkAction, DataGridProps } from './components/DataGrid.js'
export { Dialog } from './components/Dialog.js'
export type { DialogProps } from './components/Dialog.js'
export { Field, describedBy, errorId, hintId } from './components/Field.js'
export type { FieldProps } from './components/Field.js'
export { Form, formDataToObject, issuesToErrors } from './components/Form.js'
export type { FormProps, FormState } from './components/Form.js'
export { Input, Textarea } from './components/Input.js'
export type { InputProps, TextareaProps } from './components/Input.js'
export { Select } from './components/Select.js'
export type { SelectOption, SelectProps } from './components/Select.js'
export { Sheet } from './components/Sheet.js'
export type { SheetProps } from './components/Sheet.js'
export { Table } from './components/Table.js'
export type { TableColumn, TableProps } from './components/Table.js'
export { Toast, ToastProvider, ToastRegion, useToast } from './components/Toast.js'
export type { ToastApi, ToastItem, ToastOptions, ToastProps, ToastTone } from './components/Toast.js'
export { cx } from './components/cx.js'

// DataGrid query model — pure, and reused server-side by kernel.admin.
export {
  applyQuery,
  defaultQuery,
  stringify,
  toCsv,
  toggleSort,
  valueOf,
} from './components/datagrid-model.js'
export type {
  DataGridColumn,
  DataGridFilterOption,
  DataGridPage,
  DataGridQuery,
  DataGridSort,
  SortDirection,
} from './components/datagrid-model.js'

// The shell.
export { AppShell } from './shell/AppShell.js'
export type { AppShellProps } from './shell/AppShell.js'
export { Nav } from './shell/Nav.js'
export type { NavProps } from './shell/Nav.js'
export { Dashboard } from './shell/Dashboard.js'
export type { DashboardProps } from './shell/Dashboard.js'

// exposes.interface: registerNavItem, registerSurface
// exposes.registry: navigation
export {
  groupNavigation,
  navigation,
  registerNavItem,
  registerSurface,
  resolveNavigation,
  setNavigationPermissionResolver,
  surfaces,
} from './navigation.js'
export type {
  NavigationEntry,
  NavigationPermissionResolver,
  ResolveNavigationOptions,
  SurfaceArea,
  SurfaceRegistration,
} from './navigation.js'

// exposes.registry: dashboardWidgets
export { dashboardWidgets, registerDashboardWidget } from './dashboard.js'
export type {
  DashboardWidget,
  DashboardWidgetProps,
  WidgetSpan,
} from './dashboard.js'

// owns: DesignToken registry.
export {
  defaultTokens,
  resolveTokens,
  tokenNames,
  tokenRef,
  tokenVar,
  tokensToCss,
  tokensToStyle,
} from './tokens.js'
export type { TokenName, TokenOverrides, TokenSet, TokenValue } from './tokens.js'

// Slot types. Names match slots[].signature in the spec exactly.
export {
  identityDashboardWidgets,
  identityNavigationOrder,
  identityTheme,
} from './slots.js'
export type {
  DashboardWidgetsSlot,
  LogoSlot,
  LogoSlotProps,
  NavigationOrderSlot,
  ThemeSlot,
} from './slots.js'

// The registry primitive, so a capability building its own registry behaves
// the same way this one does.
export { createRegistry } from './registry.js'
export type { Registry, RegistryOptions } from './registry.js'
