/**
 * Test double for @forge/kernel-events: an in-process bus with the publish and
 * subscribe signatures the kernel declares, plus a recorder so a test can assert
 * exactly which events were published and in what order.
 */

export interface RecordedEvent {
  readonly name: string
  readonly payload: unknown
}

type Handler = (event: { name: string; payload: unknown; id?: string }) => Promise<void> | void

const handlers = new Map<string, Handler[]>()
const recorded: RecordedEvent[] = []
let seq = 0

export async function publish(name: string, payload: unknown): Promise<void> {
  recorded.push({ name, payload })
  seq += 1
  const envelope = { name, payload, id: `evt_${seq}` }
  for (const handler of handlers.get(name) ?? []) {
    await handler(envelope)
  }
}

export function subscribe(pattern: string, handler: Handler): void {
  const list = handlers.get(pattern) ?? []
  list.push(handler)
  handlers.set(pattern, list)
}

export function published(name?: string): RecordedEvent[] {
  return name === undefined ? [...recorded] : recorded.filter((e) => e.name === name)
}

export function resetEvents(): void {
  handlers.clear()
  recorded.length = 0
  seq = 0
}
