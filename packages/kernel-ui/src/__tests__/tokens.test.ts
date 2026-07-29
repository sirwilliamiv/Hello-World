/**
 * Spec smoke test: "shell renders with branding applied" —
 *   "the application shell mounts and resolves manifest brand tokens".
 *
 * The shell cannot be mounted in this workspace (no react-dom, no DOM
 * environment), so the assertion is made where it is actually load-bearing: the
 * token resolution path the shell renders through, and the invariant that makes
 * branding a token change *and nothing else* — no component may contain a
 * literal colour.
 */

import { readFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { identityTheme, type ThemeSlot } from '../slots.js'
import {
  defaultTokens,
  resolveTokens,
  tokenNames,
  tokenRef,
  tokenVar,
  tokensToCss,
  tokensToStyle,
} from '../tokens.js'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..')
const tokensCss = readFileSync(join(srcDir, 'styles/tokens.css'), 'utf8')
const componentsCss = readFileSync(join(srcDir, 'styles/components.css'), 'utf8')

describe('tokenVar', () => {
  it('matches the Go template pipeline kebab filter', () => {
    // internal/render/funcs.go: kebab = snake with '_' -> '-', splitting on
    // '.', '_', '-', ' ', '/' and on lower->upper transitions.
    expect(tokenVar('color.brand.primary')).toBe('--color-brand-primary')
    expect(tokenVar('radius.md')).toBe('--radius-md')
    expect(tokenVar('space.4')).toBe('--space-4')
    expect(tokenVar('font.size.2xl')).toBe('--font-size-2xl')
    expect(tokenVar('color.brand.on-primary')).toBe('--color-brand-on-primary')
    expect(tokenVar('layout.shell.sidebar-width')).toBe('--layout-shell-sidebar-width')
    // A camelCase manifest key must land on the same property as its dotted
    // equivalent, because the Go filter splits on the case transition too.
    expect(tokenVar('color.brand.primaryHover')).toBe('--color-brand-primary-hover')
    expect(tokenVar('color.brand.primary.hover')).toBe('--color-brand-primary-hover')
  })

  it('builds a var() reference with an optional fallback', () => {
    expect(tokenRef('radius.md')).toBe('var(--radius-md)')
    expect(tokenRef('radius.md', '4px')).toBe('var(--radius-md, 4px)')
  })
})

describe('the shipped default stylesheet', () => {
  it('declares exactly the tokens defaultTokens declares', () => {
    const declared = new Set(
      [...tokensCss.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gmu)].map((m) => m[1] as string),
    )
    const expected = new Set(Object.keys(defaultTokens).map(tokenVar))

    // Every token is reachable from CSS...
    for (const name of expected) expect(declared).toContain(name)
    // ...and nothing is declared that branding cannot address.
    for (const name of declared) expect(expected).toContain(name)
  })

  it('declares them as plain :root custom properties a later block can override', () => {
    // The generated tokens.css is a bare `:root { ... }` block imported after
    // this one. Anything stronger here — an id selector, !important, a layer —
    // would silently beat it and branding would stop working.
    expect(tokensCss).toContain(':root {')
    expect(tokensCss).not.toContain('!important')
    expect(tokensCss).not.toMatch(/@layer/u)
    expect(tokensCss).not.toMatch(/^\s*#[\w-]+\s*\{/mu)
  })

  it('has no dark-mode block that would outrank a client :root override', () => {
    // Dark mode is a token change too. Shipping a `prefers-color-scheme` block
    // here would apply this package's colours over a client's branding in dark
    // mode, which is exactly the coupling the token system exists to prevent.
    expect(tokensCss).not.toContain('prefers-color-scheme')
  })
})

describe('component styles', () => {
  it('contains no literal colour anywhere', () => {
    // This is the invariant that makes "branding is a token change and nothing
    // else" true rather than aspirational.
    // Colour keywords are matched only as whole identifiers, so a property name
    // like `white-space` is not a false positive.
    const literals = componentsCss.match(
      /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|(?<![-\w])(?:red|blue|green|black|white|grey|gray|orange|purple|yellow)(?![-\w])/gu,
    )
    expect(literals ?? []).toEqual([])
  })

  it('references only tokens that exist', () => {
    const referenced = new Set(
      [...componentsCss.matchAll(/var\((--[a-z0-9-]+)/gu)].map((m) => m[1] as string),
    )
    const known = new Set(Object.keys(defaultTokens).map(tokenVar))
    for (const name of referenced) expect(known).toContain(name)
  })

  it('is the only stylesheet the package ships', () => {
    // A capability-specific stylesheet appearing here would be the first step
    // towards capabilities shipping styles, which the spec forbids outright.
    const files = readdirSync(join(srcDir, 'styles')).sort()
    expect(files).toEqual(['components.css', 'tokens.css'])
  })
})

describe('resolveTokens', () => {
  it('starts from the defaults', () => {
    expect(resolveTokens()['color.brand.primary']).toBe(defaultTokens['color.brand.primary'])
  })

  it('applies manifest branding over the defaults', () => {
    const tokens = resolveTokens({ 'color.brand.primary': '#0F5132', 'radius.md': '0.5rem' })
    expect(tokens['color.brand.primary']).toBe('#0F5132')
    expect(tokens['radius.md']).toBe('0.5rem')
    // Unspecified tokens keep their default, per the manifest schema.
    expect(tokens['color.text.primary']).toBe(defaultTokens['color.text.primary'])
  })

  it('coerces numeric manifest values, which the schema permits', () => {
    expect(resolveTokens({ 'z.modal': 900 })['z.modal']).toBe('900')
  })

  it('applies the theme slot last, above manifest branding', () => {
    const theme: ThemeSlot = (tokens) => ({ ...tokens, 'color.brand.primary': '#000001' })
    const tokens = resolveTokens({ 'color.brand.primary': '#0F5132' }, theme)
    expect(tokens['color.brand.primary']).toBe('#000001')
  })

  it('accepts client-invented token names', () => {
    // branding.tokens is an open map in the manifest schema.
    expect(resolveTokens({ 'color.client.spot': '#123456' })['color.client.spot']).toBe(
      '#123456',
    )
  })

  it('is unchanged by the identity theme slot', () => {
    expect(resolveTokens({}, identityTheme)).toEqual(resolveTokens())
  })
})

describe('tokensToCss', () => {
  it('renders a :root block sorted by name, for a byte-stable diff', () => {
    const css = tokensToCss({ 'b.two': '2', 'a.one': '1' })
    expect(css).toBe(':root {\n  --a-one: 1;\n  --b-two: 2;\n}\n')
  })

  it('round-trips branding into the property a client would override', () => {
    const css = tokensToCss(resolveTokens({ 'color.brand.primary': '#0F5132' }))
    expect(css).toContain('--color-brand-primary: #0F5132;')
  })

  it('scopes a token set to a subtree as inline custom properties', () => {
    const style = tokensToStyle({ 'color.brand.primary': '#0F5132' })
    expect(style).toEqual({ '--color-brand-primary': '#0F5132' })
  })

  it('lists token names deterministically', () => {
    const names = tokenNames()
    expect([...names]).toEqual([...names].sort())
    expect(names.length).toBe(Object.keys(defaultTokens).length)
  })
})
