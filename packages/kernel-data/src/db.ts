/**
 * Wiring: which driver the repositories use, and where the clock and ids come
 * from.
 *
 * Called once at boot by the product. Nothing else in the system gets to reach
 * for a database handle — a capability asks for a Repository.
 */

import { DataNotConfiguredError } from './errors.js'
import { DrizzleDriver, type Database, type Executor } from './drizzle-driver.js'
import type { DataDriver } from './driver.js'

export interface DataLogger {
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

export interface DataConfiguration {
  /** A Drizzle database handle. Wrapped in the Postgres driver. */
  database?: Database | Executor
  /** Or a driver directly — the in-memory one, in tests. */
  driver?: DataDriver
  logger?: DataLogger
  /** Injectable clock, so timestamps are testable and replays deterministic. */
  now?: () => Date
  /** Injectable id factory, for the same reason. */
  newId?: () => string
}

interface ResolvedConfiguration {
  driver: DataDriver | undefined
  logger: DataLogger
  now: () => Date
  newId: () => string
}

const configuration: ResolvedConfiguration = {
  driver: undefined,
  logger: {
    warn: (message, fields) => console.warn(message, fields ?? {}),
    error: (message, fields) => console.error(message, fields ?? {}),
  },
  now: () => new Date(),
  newId: () => globalThis.crypto.randomUUID(),
}

export function configureData(options: DataConfiguration): void {
  if (options.driver !== undefined) configuration.driver = options.driver
  else if (options.database !== undefined) configuration.driver = new DrizzleDriver(options.database)
  if (options.logger !== undefined) configuration.logger = options.logger
  if (options.now !== undefined) configuration.now = options.now
  if (options.newId !== undefined) configuration.newId = options.newId
}

export function getDriver(): DataDriver {
  if (configuration.driver === undefined) throw new DataNotConfiguredError()
  return configuration.driver
}

export function isConfigured(): boolean {
  return configuration.driver !== undefined
}

export function getLogger(): DataLogger {
  return configuration.logger
}

export function now(): Date {
  return configuration.now()
}

export function newId(): string {
  return configuration.newId()
}

/** Test helper: drops the configured driver. */
export function resetData(): void {
  configuration.driver = undefined
}
