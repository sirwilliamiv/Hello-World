/**
 * Agent-callability metadata carried by the exported functions themselves.
 *
 * The catalog declares `agent_callable` and `consequence` per exposed interface.
 * `ai.agents` derives its tool list from the resolved graph, but it also needs to
 * enforce the approval rule at call time — so the classification travels with the
 * function object rather than living only in JSON that the runtime never sees.
 *
 * The rule the catalog states, made mechanical here: anything whose consequence
 * is `moves_money` requires approval REGARDLESS of the agent's trust level.
 */

export type Consequence =
  | 'read'
  | 'write'
  | 'moves_money'
  | 'external_communication'
  | 'destructive'

export type ApprovalPolicy = 'never' | 'by_trust_level' | 'always'

export interface AgentCallableMetadata {
  /** Capability id that owns the interface, e.g. `pay.card`. */
  readonly capability: string
  /** Exposed interface name, matching the spec's `exposes[].name`. */
  readonly name: string
  readonly agentCallable: boolean
  readonly consequence: Consequence
  /** `always` means no trust level, however high, can skip the approval step. */
  readonly approval: ApprovalPolicy
  readonly description?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyFn = (...args: any[]) => unknown

export type AgentAnnotated<F extends AnyFn> = F & {
  readonly agent: AgentCallableMetadata
}

const ALWAYS_APPROVED: ReadonlySet<Consequence> = new Set<Consequence>([
  'moves_money',
  'destructive',
])

/**
 * Attaches the classification to a function and returns it. The returned value is
 * the same callable, so call sites are unaffected.
 */
export function annotateAgent<F extends AnyFn>(
  fn: F,
  meta: Omit<AgentCallableMetadata, 'approval'> & { approval?: ApprovalPolicy },
): AgentAnnotated<F> {
  const approval: ApprovalPolicy = ALWAYS_APPROVED.has(meta.consequence)
    ? 'always'
    : (meta.approval ?? (meta.agentCallable ? 'by_trust_level' : 'never'))

  if (ALWAYS_APPROVED.has(meta.consequence) && meta.approval !== undefined && meta.approval !== 'always') {
    throw new Error(
      `${meta.capability}:${meta.name} has consequence '${meta.consequence}' and cannot ` +
        `declare approval '${meta.approval}'. Money movement always requires approval.`,
    )
  }

  const frozen: AgentCallableMetadata = Object.freeze({
    capability: meta.capability,
    name: meta.name,
    agentCallable: meta.agentCallable,
    consequence: meta.consequence,
    approval,
    ...(meta.description === undefined ? {} : { description: meta.description }),
  })

  Object.defineProperty(fn, 'agent', {
    value: frozen,
    enumerable: true,
    writable: false,
    configurable: false,
  })

  return fn as AgentAnnotated<F>
}

/** True when a caller must obtain approval before invoking `fn`. */
export function requiresApproval(fn: { agent?: AgentCallableMetadata }): boolean {
  return fn.agent?.approval === 'always'
}
