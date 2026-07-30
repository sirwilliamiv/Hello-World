/**
 * The engine's own guarantees: escaping, sorted iteration, and no ambient state.
 * These are unit tests because every determinism claim above them rests here.
 */
import { describe, expect, it } from 'vitest'
import { compile, sortDeep, TemplateSyntaxError, templateHelpers } from '../src/index.js'

const helpers = templateHelpers.all()

function render(source: string, data: unknown): string {
  return compile(source).render(sortDeep(data), helpers)
}

describe('template engine', () => {
  it('escapes interpolations and leaves triple braces raw', () => {
    expect(render('{{ name }}', { name: '<b>Acme & Co</b>' })).toBe(
      '&lt;b&gt;Acme &amp; Co&lt;/b&gt;',
    )
    expect(render('{{{ name }}}', { name: '<b>Acme</b>' })).toBe('<b>Acme</b>')
  })

  it('renders missing paths as empty rather than throwing', () => {
    expect(render('[{{ a.b.c }}]', {})).toBe('[]')
  })

  it('iterates arrays in order and objects in sorted key order', () => {
    expect(render('{{#each xs}}{{ this }},{{/each}}', { xs: [3, 1, 2] })).toBe('3,1,2,')

    // Same object, two insertion orders — one output.
    const first = render('{{#each o}}{{ @key }}={{ this }};{{/each}}', { o: { b: 2, a: 1, c: 3 } })
    const second = render('{{#each o}}{{ @key }}={{ this }};{{/each}}', { o: { c: 3, a: 1, b: 2 } })
    expect(first).toBe('a=1;b=2;c=3;')
    expect(second).toBe(first)
  })

  it('exposes @index, @number, @first and @last inside each', () => {
    expect(render('{{#each xs}}{{ @number }}:{{ this }}{{#unless @last}}, {{/unless}}{{/each}}', { xs: ['a', 'b'] })).toBe(
      '1:a, 2:b',
    )
  })

  it('reaches the enclosing scope with ../', () => {
    expect(
      render('{{#each lines}}{{ ../currency }} {{ this.amount }};{{/each}}', {
        currency: 'USD',
        lines: [{ amount: 1 }, { amount: 2 }],
      }),
    ).toBe('USD 1;USD 2;')
  })

  it('renders the else branch for empty collections and falsy conditions', () => {
    expect(render('{{#each xs}}x{{else}}none{{/each}}', { xs: [] })).toBe('none')
    expect(render('{{#if flag}}yes{{else}}no{{/if}}', { flag: false })).toBe('no')
    expect(render('{{#unless flag}}hidden{{/unless}}', { flag: false })).toBe('hidden')
  })

  it('names the mistake when a helper does not exist', () => {
    expect(() => render("{{ nosuch 'a' }}", {})).toThrow(/No template helper named 'nosuch'/)
  })

  it('refuses an unclosed or mismatched block at compile time', () => {
    expect(() => compile('{{#each xs}}oops')).toThrow(TemplateSyntaxError)
    expect(() => compile('{{#if a}}oops{{/each}}')).toThrow(TemplateSyntaxError)
  })
})

describe('built-in helpers are deterministic and locale-free', () => {
  it('formats money through kernel.money, in integer minor units', () => {
    // The built-in delegates; with no money implementation loaded it says so plainly.
    expect(() => render('{{ money 1000 "USD" }}', {})).toThrow(/kernel\.money|integer minor units/)
  })

  it('formats dates in UTC with fixed month names', () => {
    const data = { d: '2026-03-09T23:30:00.000Z' }
    expect(render("{{ date d 'YYYY-MM-DD' }}", data)).toBe('2026-03-09')
    expect(render("{{ date d 'DD MMMM YYYY' }}", data)).toBe('09 March 2026')
    expect(render("{{ date d 'MMM DD, YYYY HH:mm' }}", data)).toBe('Mar 09, 2026 23:30')
  })

  it('groups numbers without Intl', () => {
    expect(render('{{ number n 2 }}', { n: 1234567.891 })).toBe('1,234,567.89')
    expect(render('{{ number n }}', { n: -1500 })).toBe('-1,500')
    expect(render('{{ percent n 1 }}', { n: 12.34 })).toBe('12.3%')
  })

  it('sorts nested structures for hashing and stringification', () => {
    expect(JSON.stringify(sortDeep({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }))).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    )
  })
})
