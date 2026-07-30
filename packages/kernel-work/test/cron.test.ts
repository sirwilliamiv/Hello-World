import { describe, expect, it } from 'vitest'
import { CronParseError, nextCronOccurrence, parseCron } from '../src/cron.js'

const at = (iso: string): Date => new Date(iso)

describe('cron', () => {
  it('parses the fields of a five-field expression', () => {
    const fields = parseCron('*/15 9-17 * * 1-5')
    expect(fields.minutes).toEqual([0, 15, 30, 45])
    expect(fields.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect(fields.daysOfWeek).toEqual([1, 2, 3, 4, 5])
    expect(fields.domRestricted).toBe(false)
  })

  it('resolves aliases', () => {
    expect(parseCron('@daily').hours).toEqual([0])
    expect(parseCron('@daily').minutes).toEqual([0])
  })

  it('computes the next occurrence in UTC', () => {
    // UTC, not local time: a schedule that moves twice a year with the
    // operator's timezone is a bug nobody can reproduce.
    expect(nextCronOccurrence('0 3 * * *', at('2026-07-29T02:00:00Z')).toISOString()).toBe(
      '2026-07-29T03:00:00.000Z',
    )
    expect(nextCronOccurrence('0 3 * * *', at('2026-07-29T03:00:00Z')).toISOString()).toBe(
      '2026-07-30T03:00:00.000Z',
    )
  })

  it('honours day-of-month and day-of-week as an OR when both are restricted', () => {
    // 2026-08-01 is a Saturday; the 3rd is the next Monday.
    const next = nextCronOccurrence('0 0 1 * 1', at('2026-07-31T12:00:00Z'))
    expect(next.toISOString()).toBe('2026-08-01T00:00:00.000Z')
    expect(nextCronOccurrence('0 0 1 * 1', next).toISOString()).toBe(
      '2026-08-03T00:00:00.000Z',
    )
  })

  it('crosses a month and a year boundary', () => {
    expect(nextCronOccurrence('0 0 1 1 *', at('2026-12-31T23:59:00Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    )
  })

  it('rejects a malformed expression by name', () => {
    expect(() => parseCron('0 3 * *')).toThrow(CronParseError)
    expect(() => parseCron('99 3 * * *')).toThrow(/outside 0-59/)
  })
})
