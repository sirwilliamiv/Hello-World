import { requireInvoicesRuntime } from './config.js'
import { publishInvoiceEvent } from './events.js'

/**
 * The overdue sweep, published on the schedule the manifest's
 * `overdue_check_cron` names.
 *
 * The function is exported rather than self-scheduling: scheduling belongs to
 * kernel.work / ops.queue, which pay.invoices does not require, so the generated
 * wiring is what binds `overdueCheckCron` to this call.
 */

export interface OverdueSweepResult {
  readonly checked: number
  readonly published: number
}

export function overdueCheckCron(): string {
  return requireInvoicesRuntime().overdueCheckCron
}

export async function checkOverdueInvoices(asOf?: Date): Promise<OverdueSweepResult> {
  const rt = requireInvoicesRuntime()
  const now = asOf ?? rt.clock()

  const rows = await rt.store.transaction((tx) => tx.listOverdueInvoices(now))

  let published = 0
  for (const row of rows) {
    const outstanding = row.totalMinor - row.paidMinor - row.creditedMinor
    if (outstanding <= 0) continue
    const daysOverdue = Math.floor((now.getTime() - row.dueAt.getTime()) / 86_400_000)
    if (daysOverdue < 1) continue
    await publishInvoiceEvent('invoice.overdue', {
      invoice_id: row.id,
      days_overdue: daysOverdue,
      outstanding_minor: outstanding,
    })
    published += 1
  }

  return { checked: rows.length, published }
}
