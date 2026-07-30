import type { JSX } from 'react'
import type { Invoice, InvoiceStatus } from './types.js'

/**
 * The invoice list surface (`/invoices`, permission `invoice.read`).
 *
 * Presentational only: it renders `Invoice` values the server has already
 * resolved. Money is formatted through the caller-supplied formatter, which
 * defaults to `Money.format()` — the component never does arithmetic on an
 * amount, because money arithmetic belongs in kernel.money.
 */

export interface InvoiceListProps {
  readonly invoices: readonly Invoice[]
  readonly emptyMessage?: string
  readonly formatMoney?: (amount: Invoice['total']) => string
  readonly formatDate?: (date: Date) => string
  readonly onSelect?: (invoiceId: string) => void
  readonly statusFilter?: readonly InvoiceStatus[]
}

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  open: 'Open',
  part_paid: 'Partly paid',
  paid: 'Paid',
  void: 'Void',
}

function defaultFormatMoney(amount: Invoice['total']): string {
  return (amount as unknown as { format?: () => string }).format?.() ?? ''
}

function defaultFormatDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function InvoiceList(props: InvoiceListProps): JSX.Element {
  const formatMoney = props.formatMoney ?? defaultFormatMoney
  const formatDate = props.formatDate ?? defaultFormatDate
  const rows =
    props.statusFilter === undefined
      ? props.invoices
      : props.invoices.filter((i) => props.statusFilter?.includes(i.status) === true)

  if (rows.length === 0) {
    return (
      <p className="forge-invoice-list forge-invoice-list--empty">
        {props.emptyMessage ?? 'No invoices yet.'}
      </p>
    )
  }

  return (
    <table className="forge-invoice-list" data-capability="pay.invoices">
      <thead>
        <tr>
          <th scope="col">Number</th>
          <th scope="col">Issued</th>
          <th scope="col">Due</th>
          <th scope="col">Total</th>
          <th scope="col">Outstanding</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((invoice) => (
          <tr
            key={invoice.id}
            className={`forge-invoice-list__row forge-invoice-list__row--${invoice.status}`}
            data-invoice-id={invoice.id}
          >
            <td>{invoice.number}</td>
            <td>{formatDate(invoice.issuedAt)}</td>
            <td>{formatDate(invoice.dueAt)}</td>
            <td>{formatMoney(invoice.total)}</td>
            <td>{formatMoney(invoice.outstanding)}</td>
            <td>{STATUS_LABEL[invoice.status]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default InvoiceList
