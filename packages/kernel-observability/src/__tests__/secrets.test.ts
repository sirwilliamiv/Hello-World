/**
 * Spec smoke test: "secrets are not logged" —
 *   "a log call carrying a value bound to a declared credential emits a
 *    redacted field".
 *
 * ARCHITECTURE §9.4 is explicit that redaction is "by type, not by
 * pattern-matching on key names", so these tests assert both halves: a Secret
 * is always redacted whatever it is called, and a plain string is never
 * redacted just because its key looks sensitive.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { captureError, resetErrorReporters, registerErrorReporter } from '../errors.js'
import { Logger, type LogRecord } from '../logger.js'
import { redact } from '../redact.js'
import {
  MissingCredentialError,
  REDACTED,
  Secret,
  bindCredentials,
  credential,
  isSecret,
  optionalCredential,
  secret,
} from '../secret.js'

const LIVE_KEY = 'sk_live_51NotARealKeyAtAll'

function capturing(): { records: LogRecord[]; logger: Logger } {
  const records: LogRecord[] = []
  const logger = new Logger({ level: 'debug', sink: (r) => records.push(r) })
  return { records, logger }
}

describe('Secret', () => {
  it('never yields its value through any serialisation path', () => {
    const s = secret(LIVE_KEY, 'STRIPE_SECRET_KEY')

    expect(String(s)).toBe(REDACTED)
    expect(`${s}`).toBe(REDACTED)
    expect(s.toString()).toBe(REDACTED)
    expect(JSON.stringify(s)).toBe(`"${REDACTED}"`)
    expect(JSON.stringify({ key: s })).toBe(`{"key":"${REDACTED}"}`)
    expect(s + '').toBe(REDACTED)
    expect(Object.keys(s)).not.toContain(LIVE_KEY)
    expect(JSON.stringify(Object.entries(s))).not.toContain(LIVE_KEY)
  })

  it('yields the value only through expose()', () => {
    const s = secret(LIVE_KEY)
    expect(s.expose()).toBe(LIVE_KEY)
  })

  it('recognises secrets by brand, not by instanceof', () => {
    // Simulates a second copy of this package in the module graph: a different
    // class, same global symbol brand.
    const foreign = Object.defineProperty({}, Symbol.for('@forge/kernel-observability:Secret'), {
      value: true,
      enumerable: false,
    })
    expect(isSecret(foreign)).toBe(true)
    expect(isSecret(new Secret('x'))).toBe(true)
    expect(isSecret('x')).toBe(false)
    expect(isSecret(null)).toBe(false)
  })

  it('maps to a derived secret without widening the value', () => {
    const derived = secret('abcdef', 'TOKEN').map((v) => v.slice(0, 3))
    expect(isSecret(derived)).toBe(true)
    expect(derived.expose()).toBe('abc')
    expect(JSON.stringify(derived)).toBe(`"${REDACTED}"`)
  })
})

describe('credential binding', () => {
  it('binds a declared credential name to a Secret', () => {
    const bound = credential('STRIPE_SECRET_KEY', { STRIPE_SECRET_KEY: LIVE_KEY })
    expect(isSecret(bound)).toBe(true)
    expect(bound.name).toBe('STRIPE_SECRET_KEY')
    expect(bound.expose()).toBe(LIVE_KEY)
  })

  it('fails loudly on a missing required credential', () => {
    expect(() => credential('STRIPE_SECRET_KEY', {})).toThrow(MissingCredentialError)
  })

  it('returns undefined for an absent optional credential', () => {
    expect(optionalCredential('ERROR_TRACKING_DSN', {})).toBeUndefined()
    expect(optionalCredential('ERROR_TRACKING_DSN', { ERROR_TRACKING_DSN: '' })).toBeUndefined()
  })

  it('binds a whole declared credential list', () => {
    const bound = bindCredentials(['A', 'B'], { A: '1', B: '2' })
    expect(Object.keys(bound).sort()).toEqual(['A', 'B'])
    expect(JSON.stringify(bound)).toBe(`{"A":"${REDACTED}","B":"${REDACTED}"}`)
  })
})

describe('logger redaction', () => {
  it('emits a redacted field for a bound credential', () => {
    const { records, logger } = capturing()
    const stripeKey = credential('STRIPE_SECRET_KEY', { STRIPE_SECRET_KEY: LIVE_KEY })

    logger.info('charging card', { stripeKey, amount: 1250 })

    const record = records[0]
    expect(record).toBeDefined()
    expect(record?.fields['stripeKey']).toBe(REDACTED)
    expect(record?.fields['amount']).toBe(1250)
    expect(JSON.stringify(record)).not.toContain(LIVE_KEY)
  })

  it('redacts secrets nested at any depth, in arrays, Maps and Sets', () => {
    const { records, logger } = capturing()
    const s = secret(LIVE_KEY, 'STRIPE_SECRET_KEY')

    logger.info('deep', {
      a: { b: { c: [s, { d: s }] } },
      m: new Map([['k', s]]),
      set: new Set([s]),
    })

    expect(JSON.stringify(records[0])).not.toContain(LIVE_KEY)
    expect(JSON.stringify(records[0])).toContain(REDACTED)
  })

  it('redacts a secret carried on a child logger binding', () => {
    const { records, logger } = capturing()
    const child = logger.child({ apiKey: secret(LIVE_KEY, 'API_KEY') })

    child.warn('outbound call failed')

    expect(records[0]?.fields['apiKey']).toBe(REDACTED)
    expect(JSON.stringify(records[0])).not.toContain(LIVE_KEY)
  })

  it('redacts a secret attached to an Error, including via cause', () => {
    const { records, logger } = capturing()
    const inner = new Error('upstream refused')
    Object.assign(inner, { token: secret(LIVE_KEY, 'TOKEN') })
    const outer = new Error('charge failed', { cause: inner })

    logger.error('boom', { error: outer })

    expect(JSON.stringify(records[0])).not.toContain(LIVE_KEY)
  })

  it('does NOT redact by key name — that is the failure mode §9.4 rejects', () => {
    const { records, logger } = capturing()

    // A plain string in a scary-looking key is emitted verbatim: name-based
    // redaction would give false confidence here and miss `sk` next door.
    logger.info('config', { password: 'not-actually-secret', publicKey: 'pk_live_ok' })

    expect(records[0]?.fields['password']).toBe('not-actually-secret')
    expect(records[0]?.fields['publicKey']).toBe('pk_live_ok')
  })

  it('survives circular structures without hanging', () => {
    const { records, logger } = capturing()
    const cyclic: Record<string, unknown> = { name: 'a' }
    cyclic['self'] = cyclic

    logger.info('cyclic', { cyclic })

    expect(JSON.stringify(records[0])).toContain('[circular]')
  })

  it('respects the level threshold', () => {
    const records: LogRecord[] = []
    const logger = new Logger({ level: 'warn', sink: (r) => records.push(r) })
    logger.info('ignored')
    logger.error('kept')
    expect(records.map((r) => r.msg)).toEqual(['kept'])
  })
})

describe('captureError', () => {
  beforeEach(() => {
    resetErrorReporters()
  })

  it('hands reporters an already-redacted payload', () => {
    const seen: unknown[] = []
    registerErrorReporter((captured) => {
      seen.push(captured)
    })

    captureError(new Error('charge failed'), {
      stripeKey: secret(LIVE_KEY, 'STRIPE_SECRET_KEY'),
    })

    expect(JSON.stringify(seen)).not.toContain(LIVE_KEY)
    expect(JSON.stringify(seen)).toContain(REDACTED)
  })

  it('does not let a throwing reporter escape', () => {
    registerErrorReporter(() => {
      throw new Error('reporter is down')
    })
    expect(() => captureError(new Error('original'))).not.toThrow()
  })
})

describe('redact', () => {
  it('produces JSON-safe output for exotic values', () => {
    const out = redact({
      when: new Date('2026-07-15T00:00:00.000Z'),
      big: 10n,
      fn: function named() {},
      sym: Symbol('s'),
      re: /ab+c/u,
    }) as Record<string, unknown>

    expect(out['when']).toBe('2026-07-15T00:00:00.000Z')
    expect(out['big']).toBe('10n')
    expect(out['fn']).toBe('[function named]')
    expect(out['re']).toBe('ab+c')
  })

  it('truncates beyond the depth limit rather than recursing forever', () => {
    let deep: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 30; i += 1) deep = { next: deep }
    expect(JSON.stringify(redact(deep))).toContain('[truncated]')
  })
})
