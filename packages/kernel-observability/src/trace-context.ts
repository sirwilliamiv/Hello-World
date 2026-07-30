/**
 * Ambient trace context.
 *
 * Kept in its own module so `logger` can stamp trace ids onto records without
 * importing the tracer, and the tracer can write records through the logger,
 * without a cycle between the two.
 */

export interface TraceContext {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
}

interface ContextStore {
  getStore(): TraceContext | undefined
  run<R>(store: TraceContext, fn: () => R): R
}

/**
 * The fallback store: a single mutable slot, restored on unwind. Correct for
 * synchronous and simple await chains; it can mislabel a trace id under heavy
 * interleaving, which is why `installAsyncContext()` upgrades it at boot.
 */
function slotStore(): ContextStore {
  let current: TraceContext | undefined
  return {
    getStore: () => current,
    run<R>(store: TraceContext, fn: () => R): R {
      const previous = current
      current = store
      try {
        return fn()
      } finally {
        current = previous
      }
    },
  }
}

let store: ContextStore = slotStore()

/**
 * Swap in `AsyncLocalStorage` when the runtime has it.
 *
 * Called by `initObservability`. `node:async_hooks` is absent on the Next.js
 * edge runtime, so this is a dynamic import behind a try/catch rather than a
 * top-level one — a missing module must degrade tracing, not fail the boot.
 */
export async function installAsyncContext(): Promise<boolean> {
  try {
    const { AsyncLocalStorage } = await import('node:async_hooks')
    store = new AsyncLocalStorage<TraceContext>() as unknown as ContextStore
    return true
  } catch {
    return false
  }
}

export function currentTraceContext(): TraceContext | undefined {
  return store.getStore()
}

export function runWithTraceContext<R>(context: TraceContext, fn: () => R): R {
  return store.run(context, fn)
}

/** Test seam: drop back to the fallback store. */
export function resetTraceContext(): void {
  store = slotStore()
}
