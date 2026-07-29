/**
 * The design token set.
 *
 * This is the entire visual surface of a Forge product. Branding a client is a
 * token change and nothing else — `templates/kernel.ui/tokens.css.tmpl` renders
 * a `:root` block from `branding.tokens` in the manifest, which is imported
 * after this package's stylesheet and therefore wins on source order.
 *
 * The consequence that matters for §4: a client's look never appears in a
 * managed TypeScript file, so it never enters the upgrade merge path.
 *
 * Token names are dotted, lower-case segments. The CSS custom property name is
 * the kebab-cased form, which is exactly what the Go template pipeline's
 * `kebab` filter produces from the same manifest key — see
 * `internal/render/funcs.go`. `tokenVar()` below reimplements that function so
 * a test can prove the two agree; if they ever diverge, a client's branding
 * silently stops applying.
 */

export type TokenValue = string

/**
 * Convert a manifest token key to its CSS custom property name.
 *
 * Mirrors `kebab` in internal/render/funcs.go: split on `.`, `_`, `-`, ` `, `/`
 * and on lower→upper case transitions, lower-case each word, join with `-`.
 */
export function tokenVar(name: string): string {
  const words: string[] = []
  let current = ''
  for (let i = 0; i < name.length; i += 1) {
    const ch = name[i] as string
    if (ch === '.' || ch === '_' || ch === '-' || ch === ' ' || ch === '/') {
      if (current.length > 0) {
        words.push(current)
        current = ''
      }
      continue
    }
    if (ch >= 'A' && ch <= 'Z' && i > 0 && current.length > 0) {
      words.push(current)
      current = ch
      continue
    }
    current += ch
  }
  if (current.length > 0) words.push(current)
  return `--${words.map((w) => w.toLowerCase()).join('-')}`
}

/** `var(--color-brand-primary)`, for use in this package's own stylesheets. */
export function tokenRef(name: string, fallback?: string): string {
  return fallback === undefined
    ? `var(${tokenVar(name)})`
    : `var(${tokenVar(name)}, ${fallback})`
}

/**
 * The defaults.
 *
 * Deliberately unbranded: a neutral grey scale and a single blue. A product
 * that ships without manifest branding should look plain and finished, not like
 * someone else's product with the logo swapped.
 */
export const defaultTokens = {
  // ── Brand ───────────────────────────────────────────────────────────────
  'color.brand.primary': '#2563eb',
  'color.brand.primary.hover': '#1d4ed8',
  'color.brand.primary.active': '#1e40af',
  'color.brand.primary.subtle': '#eff6ff',
  'color.brand.on-primary': '#ffffff',
  'color.brand.accent': '#7c3aed',

  // ── Surfaces ────────────────────────────────────────────────────────────
  'color.surface.base': '#ffffff',
  'color.surface.raised': '#ffffff',
  'color.surface.sunken': '#f6f7f9',
  'color.surface.overlay': 'rgba(15, 23, 42, 0.45)',
  'color.surface.hover': '#f1f3f6',
  'color.surface.selected': '#e8eefc',

  // ── Borders ─────────────────────────────────────────────────────────────
  'color.border.subtle': '#eceef1',
  'color.border.default': '#d8dce2',
  'color.border.strong': '#a8b0bb',

  // ── Text ────────────────────────────────────────────────────────────────
  'color.text.primary': '#111827',
  'color.text.secondary': '#4b5563',
  'color.text.muted': '#6b7280',
  'color.text.inverse': '#ffffff',
  'color.text.link': '#1d4ed8',

  // ── Status ──────────────────────────────────────────────────────────────
  'color.status.success': '#15803d',
  'color.status.success.surface': '#f0fdf4',
  'color.status.warning': '#b45309',
  'color.status.warning.surface': '#fffbeb',
  'color.status.danger': '#b91c1c',
  'color.status.danger.surface': '#fef2f2',
  'color.status.info': '#1d4ed8',
  'color.status.info.surface': '#eff6ff',

  'color.focus.ring': 'rgba(37, 99, 235, 0.45)',

  // ── Typography ──────────────────────────────────────────────────────────
  'font.sans':
    "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  'font.mono': "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  'font.size.xs': '0.75rem',
  'font.size.sm': '0.8125rem',
  'font.size.md': '0.875rem',
  'font.size.lg': '1rem',
  'font.size.xl': '1.25rem',
  'font.size.2xl': '1.5rem',
  'font.weight.regular': '400',
  'font.weight.medium': '500',
  'font.weight.semibold': '600',
  'font.weight.bold': '700',
  'line.height.tight': '1.25',
  'line.height.normal': '1.5',
  'line.height.relaxed': '1.7',

  // ── Space ───────────────────────────────────────────────────────────────
  'space.0': '0',
  'space.1': '0.25rem',
  'space.2': '0.5rem',
  'space.3': '0.75rem',
  'space.4': '1rem',
  'space.5': '1.25rem',
  'space.6': '1.5rem',
  'space.8': '2rem',
  'space.10': '2.5rem',
  'space.12': '3rem',

  // ── Radius, borders, elevation ──────────────────────────────────────────
  'radius.none': '0',
  'radius.sm': '0.25rem',
  'radius.md': '0.375rem',
  'radius.lg': '0.625rem',
  'radius.full': '9999px',
  'border.width.thin': '1px',
  'border.width.thick': '2px',
  'shadow.sm': '0 1px 2px rgba(15, 23, 42, 0.06)',
  'shadow.md': '0 4px 12px rgba(15, 23, 42, 0.1)',
  'shadow.lg': '0 16px 40px rgba(15, 23, 42, 0.16)',

  // ── Layers ──────────────────────────────────────────────────────────────
  'z.base': '0',
  'z.sticky': '100',
  'z.dropdown': '200',
  'z.overlay': '300',
  'z.modal': '400',
  'z.toast': '500',

  // ── Motion ──────────────────────────────────────────────────────────────
  'motion.duration.fast': '120ms',
  'motion.duration.normal': '200ms',
  'motion.duration.slow': '320ms',
  'motion.easing.standard': 'cubic-bezier(0.2, 0, 0, 1)',

  // ── Shell layout ────────────────────────────────────────────────────────
  'layout.shell.sidebar-width': '15rem',
  'layout.shell.header-height': '3.5rem',
  'layout.content.max-width': '80rem',
  'layout.content.gutter': '1.5rem',
} as const satisfies Record<string, TokenValue>

export type TokenName = keyof typeof defaultTokens

/** A complete resolved token set. */
export type TokenSet = Record<TokenName, TokenValue> & Record<string, TokenValue>

/**
 * Overrides. A client may introduce token names of its own — the manifest
 * schema allows any key under `branding.tokens` — so this is deliberately open.
 */
export type TokenOverrides = Readonly<Record<string, TokenValue | number>>

/** Every declared token name, sorted. Output order must be deterministic (§10). */
export function tokenNames(): readonly string[] {
  return Object.keys(defaultTokens).sort()
}

/**
 * Fold manifest branding and the client's `theme` slot over the defaults.
 *
 * Precedence, lowest first: package defaults → manifest branding → theme slot.
 */
export function resolveTokens(
  overrides: TokenOverrides = {},
  theme?: (tokens: TokenSet) => TokenSet,
): TokenSet {
  const resolved: Record<string, TokenValue> = { ...defaultTokens }
  for (const [name, value] of Object.entries(overrides)) {
    resolved[name] = typeof value === 'number' ? String(value) : value
  }
  const merged = resolved as TokenSet
  return theme === undefined ? merged : theme(merged)
}

/**
 * Render a token set as a `:root` block.
 *
 * Sorted by name, because unsorted output would produce a spurious diff on
 * every render (§10) — the same reason the Go renderer sorts every slice.
 */
export function tokensToCss(tokens: Readonly<Record<string, TokenValue>>, selector = ':root'): string {
  const lines = Object.keys(tokens)
    .sort()
    .map((name) => `  ${tokenVar(name)}: ${String(tokens[name])};`)
  return `${selector} {\n${lines.join('\n')}\n}\n`
}

/**
 * A React `style` object of custom properties, for scoping a token override to
 * a subtree (a preview pane, a tenant-specific area) without a stylesheet.
 */
export function tokensToStyle(
  tokens: Readonly<Record<string, TokenValue>>,
): Record<string, string> {
  const style: Record<string, string> = {}
  for (const name of Object.keys(tokens).sort()) {
    style[tokenVar(name)] = String(tokens[name])
  }
  return style
}
