/**
 * @forge/kernel-events — the runtime half of kernel.events@1.0.0
 *
 * The only sanctioned path for cross-capability communication. Direct calls
 * between capabilities are prohibited except through explicitly exposed
 * interfaces. Schemas are registered and versioned; publishing an event whose
 * schema is not registered throws.
 *
 * Spec: catalog/kernel/kernel.events.capability.json
 */

export {
  configureEventBus,
  eventBus,
  EventBus,
  listDeadLetters,
  publish,
  replayDeadLetter,
  resetEventBus,
  subscribe,
  type EventBusLogger,
  type EventBusOptions,
} from './bus.js'

export {
  clearEventSchemas,
  contractVersionsOf,
  eventSchemas,
  getEventSchema,
  hasEventSchema,
  listEventSchemas,
  registerEventSchema,
  validatePayload,
  type EventSchemaRegistration,
} from './registry.js'

export { assertValidPattern, matchesPattern } from './pattern.js'

export {
  InMemoryEventStore,
  type DeadLetterQuery,
  type EventQuery,
  type EventStore,
} from './store.js'

export { DrizzleEventStore, type EventsDatabase } from './drizzle-store.js'

export {
  DuplicateEventSchemaError,
  EventBusError,
  EventPayloadValidationError,
  InvalidEventPatternError,
  UnregisteredEventSchemaError,
} from './errors.js'

export { deadLetters, events, subscriptions } from './schema.js'
export type { DeadLetterRow, EventRow, SubscriptionRow } from './schema.js'

export type {
  DeadLetterRecord,
  Event,
  EventEnvelope,
  EventHandler,
  EventName,
  EventPattern,
  EventPayloadMap,
  KnownEventName,
  PayloadOf,
  PublishOptions,
  SubscribeOptions,
  Subscription,
} from './types.js'
