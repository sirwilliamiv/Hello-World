/**
 * Smoke test: "migrations apply and roll back".
 *
 * The runner's own responsibilities are what is under test here — ordering, the
 * ledger, the immutability check, and refusing to roll back a migration whose
 * script is unavailable. The SQL itself is exercised against a real database in
 * the client's smoke tests, where a migration failing means something about
 * *that* client's schema.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { configureData } from '../db.js'
import { InMemoryDriver } from '../driver.js'
import { MigrationChecksumMismatchError, MigrationError } from '../errors.js'
import {
  appliedMigrations,
  rollbackAll,
  rollbackMigration,
  runMigrations,
  type MigrationDescriptor,
} from '../migrations.js'

let root: string
let driver: InMemoryDriver

async function writeMigration(id: string, up: string, down: string): Promise<MigrationDescriptor> {
  await writeFile(join(root, `${id}.up.sql`), up, 'utf8')
  await writeFile(join(root, `${id}.down.sql`), down, 'utf8')
  return { capability: 'kernel.data', id, up: `${id}.up.sql`, down: `${id}.down.sql` }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'forge-migrations-'))
  driver = new InMemoryDriver()
  configureData({
    driver,
    now: () => new Date(0),
    logger: { warn: () => undefined, error: () => undefined },
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('runMigrations', () => {
  it('applies every migration once, in the order given, and records the ledger', async () => {
    const first = await writeMigration('20260601_create_a', 'create table a ()', 'drop table a')
    const second = await writeMigration('20260602_create_b', 'create table b ()', 'drop table b')

    const run = await runMigrations([first, second], { root })
    expect(run.applied).toEqual(['20260601_create_a', '20260602_create_b'])
    expect(driver.statements).toContain('create table a ()')
    expect(driver.statements).toContain('create table b ()')

    const ledger = await appliedMigrations()
    expect(ledger.map((entry) => entry.id)).toEqual([
      '20260601_create_a',
      '20260602_create_b',
    ])
    expect(ledger.map((entry) => entry.appliedSerial)).toEqual([1, 2])
    expect(ledger.every((entry) => entry.rollbackAvailable)).toBe(true)

    // Second run is a no-op: nothing applied, everything skipped.
    const again = await runMigrations([first, second], { root })
    expect(again.applied).toEqual([])
    expect(again.skipped).toEqual(['20260601_create_a', '20260602_create_b'])
  })

  it('stops when an applied migration has been edited since', async () => {
    const migration = await writeMigration('20260601_create_a', 'create table a ()', 'drop table a')
    await runMigrations([migration], { root })

    await writeFile(join(root, '20260601_create_a.up.sql'), 'create table a (x int)', 'utf8')
    await expect(runMigrations([migration], { root })).rejects.toThrow(
      MigrationChecksumMismatchError,
    )
  })

  it('reports what would run without applying it', async () => {
    const migration = await writeMigration('20260601_create_a', 'create table a ()', 'drop table a')
    const run = await runMigrations([migration], { root, dryRun: true })

    expect(run.applied).toEqual(['20260601_create_a'])
    expect(driver.statements).not.toContain('create table a ()')
    expect(await appliedMigrations()).toHaveLength(0)
  })

  it('rolls the ledger row back with the migration when one fails', async () => {
    const good = await writeMigration('20260601_create_a', 'create table a ()', 'drop table a')
    const bad = await writeMigration('20260602_create_b', 'create table b ()', 'drop table b')

    const failing = new InMemoryDriver()
    let calls = 0
    failing.executeSql = (statement: string): Promise<void> => {
      calls += 1
      if (statement.includes('create table b')) return Promise.reject(new Error('syntax error'))
      return Promise.resolve()
    }

    await expect(runMigrations([good, bad], { root, driver: failing })).rejects.toThrow(
      MigrationError,
    )
    expect(calls).toBeGreaterThan(0)

    const ledger = await appliedMigrations({ driver: failing })
    expect(ledger.map((entry) => entry.id)).toEqual(['20260601_create_a'])
  })

  it('runs a code migration through the same ledger', async () => {
    const applied: string[] = []
    const codeMigration = {
      id: '20260603_backfill',
      capability: 'kernel.data',
      up: async () => {
        applied.push('up')
      },
      down: async () => {
        applied.push('down')
      },
    }

    await runMigrations([codeMigration], { root })
    expect(applied).toEqual(['up'])
    expect((await appliedMigrations()).map((entry) => entry.id)).toEqual(['20260603_backfill'])

    await rollbackMigration('20260603_backfill', [codeMigration], { root })
    expect(applied).toEqual(['up', 'down'])
    expect(await appliedMigrations()).toHaveLength(0)
  })
})

describe('rollback', () => {
  it('runs the down script and removes the ledger row', async () => {
    const migration = await writeMigration('20260601_create_a', 'create table a ()', 'drop table a')
    await runMigrations([migration], { root })

    await rollbackMigration('20260601_create_a', [migration], { root })
    expect(driver.statements).toContain('drop table a')
    expect(await appliedMigrations()).toHaveLength(0)

    // And it can be applied again afterwards — forward and back against an
    // empty database is the property the spec's smoke test names.
    const rerun = await runMigrations([migration], { root })
    expect(rerun.applied).toEqual(['20260601_create_a'])
  })

  it('rolls every migration back, newest first', async () => {
    const first = await writeMigration('20260601_create_a', 'create table a ()', 'drop table a')
    const second = await writeMigration('20260602_create_b', 'create table b ()', 'drop table b')
    await runMigrations([first, second], { root })

    const rolledBack = await rollbackAll([first, second], { root })
    expect(rolledBack).toEqual(['20260602_create_b', '20260601_create_a'])
    expect(await appliedMigrations()).toHaveLength(0)
  })

  it('refuses to roll back a migration with no rollback script', async () => {
    await writeFile(join(root, 'client.up.sql'), 'create table client_thing ()', 'utf8')
    const clientEntities = {
      capability: '<client>',
      id: '20260604_client_entities',
      up: 'client.up.sql',
      down: '',
    }

    await runMigrations([clientEntities], { root })
    const [entry] = await appliedMigrations()
    expect(entry?.rollbackAvailable).toBe(false)

    await expect(rollbackMigration(entry?.id ?? '', [clientEntities], { root })).rejects.toThrow(
      /ships no rollback script/,
    )
  })

  it('refuses to roll back something that was never applied', async () => {
    await expect(rollbackMigration('20260601_nope', [], { root })).rejects.toThrow(
      /is not applied/,
    )
  })
})
