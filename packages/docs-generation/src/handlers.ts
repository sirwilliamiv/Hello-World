/**
 * The four declared `consumes` handlers, wired by
 * `src/generated/kernel.events/subscriptions.ts`.
 *
 * Each of them is a thin, idempotent shim: the event payload becomes the render data
 * and the subject is the entity the document is about. Because `generate` derives the
 * document id from (template, pinned version, format, data, subject), redelivering an
 * event does not produce a second document — it returns the first one.
 *
 * Note recorded in the report: rendering is slow and `docs.generation` does not
 * declare `ops.queue` in `requires`, so these handlers render inline. Making the
 * render durable is a one-line change here once that dependency is declared.
 */
import { generate } from './documents.js'
import { TemplateNotFoundError } from './errors.js'
import type { GeneratedDocument } from './types.js'

export interface DomainEvent<P = Record<string, unknown>> {
  readonly name?: string
  readonly payload: P
}

/** A capability's document may simply not be installed for a client. That is fine. */
async function renderIfTemplateExists(
  templateKey: string,
  data: Record<string, unknown>,
  subjectRef: string,
): Promise<GeneratedDocument | null> {
  try {
    return await generate(templateKey, data, { subjectRef })
  } catch (err) {
    if (err instanceof TemplateNotFoundError) return null
    throw err
  }
}

/** `invoice.created` → render the invoice PDF as soon as it is issued. */
export async function renderInvoice(
  event: DomainEvent<{
    invoice_id: string
    number: string
    customer_id: string
    total_minor: number
    currency: string
    due_at: string
    legal_entity?: string
  }>,
): Promise<GeneratedDocument | null> {
  const p = event.payload
  return renderIfTemplateExists(
    'invoice',
    {
      invoice: {
        id: p.invoice_id,
        number: p.number,
        customer_id: p.customer_id,
        // Money stays in integer minor units all the way to the template helper.
        total_minor: p.total_minor,
        currency: p.currency,
        due_at: p.due_at,
        legal_entity: p.legal_entity ?? null,
      },
    },
    `Invoice:${p.invoice_id}`,
  )
}

/** `quote.requested` → render a quote document when a quoting capability is present. */
export async function renderQuote(
  event: DomainEvent<{ quote_id: string } & Record<string, unknown>>,
): Promise<GeneratedDocument | null> {
  return renderIfTemplateExists('quote', { quote: event.payload }, `Quote:${event.payload.quote_id}`)
}

/** `job.completed` → render a completion summary when ops.dispatch is present. */
export async function renderJobSummary(
  event: DomainEvent<{ job_id: string } & Record<string, unknown>>,
): Promise<GeneratedDocument | null> {
  return renderIfTemplateExists('job-summary', { job: event.payload }, `Job:${event.payload.job_id}`)
}

/** `report.scheduled` → render a scheduled report when ops.reporting is present. */
export async function renderReport(
  event: DomainEvent<{ report_id: string; period?: string } & Record<string, unknown>>,
): Promise<GeneratedDocument | null> {
  const p = event.payload
  return renderIfTemplateExists(
    'report',
    { report: p },
    `Report:${p.report_id}${p.period === undefined ? '' : `:${p.period}`}`,
  )
}
