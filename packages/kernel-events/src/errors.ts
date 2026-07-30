/**
 * Errors raised by the event bus.
 *
 * The bus is the only sanctioned path for cross-capability communication, which
 * means every one of these failures is a contract violation between two
 * capabilities. They all name both sides, because the person reading the error
 * is rarely the person who wrote either one.
 */

export class EventBusError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/**
 * An event was published whose schema is not in the registry.
 *
 * This is the runtime half of the rule that CI enforces statically: a capability
 * may only publish events declared in its own specification. Silently dropping
 * the event would hide the mismatch until a consumer noticed it was never called.
 */
export class UnregisteredEventSchemaError extends EventBusError {
  constructor(
    readonly event: string,
    readonly contractVersion?: number,
  ) {
    super(
      contractVersion === undefined
        ? `event ${JSON.stringify(event)} has no registered schema: declare it in the publishing capability's \`publishes\` block so it is registered from the resolved graph`
        : `event ${JSON.stringify(event)} has no registered schema at contract version ${String(contractVersion)}`,
    )
  }
}

/** A payload did not satisfy the registered schema for its event and version. */
export class EventPayloadValidationError extends EventBusError {
  constructor(
    readonly event: string,
    readonly contractVersion: number,
    readonly issues: readonly string[],
  ) {
    super(
      `payload for ${event} (contract v${String(contractVersion)}) does not match its registered schema: ${issues.join('; ')}`,
    )
  }
}

/** A schema was registered twice for the same event and contract version with a different shape. */
export class DuplicateEventSchemaError extends EventBusError {
  constructor(
    readonly event: string,
    readonly contractVersion: number,
  ) {
    super(
      `event ${event} already has a different schema registered at contract version ${String(contractVersion)}: a contract change requires a new contract_version, not an edit to an existing one`,
    )
  }
}

/** A subscription pattern that is not an event name, a glob, or '**'. */
export class InvalidEventPatternError extends EventBusError {
  constructor(readonly pattern: string) {
    super(`invalid event pattern ${JSON.stringify(pattern)}`)
  }
}
