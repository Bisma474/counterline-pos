import type { LocalOrder, LocalOrderItem, LocalPayment, OutboxEntry } from './db'

export interface LocalSalesReport {
  grossSalesCents: number
  discountCents: number
  netSalesCents: number
  taxCents: number
  cashTakingsCents: number
  cardTakingsCents: number
  recordedTotalCents: number
  completedOrderCount: number
  averageSaleCents: number
  itemsSold: number
  pendingCount: number
  pendingAmountCents: number
  rejectedCount: number
  rejectedAmountCents: number
}

export interface ReportingData {
  orders: LocalOrder[]
  items: LocalOrderItem[]
  payments: LocalPayment[]
  outbox: OutboxEntry[]
}

const emptyReport = (): LocalSalesReport => ({
  grossSalesCents: 0, discountCents: 0, netSalesCents: 0, taxCents: 0,
  cashTakingsCents: 0, cardTakingsCents: 0, recordedTotalCents: 0,
  completedOrderCount: 0, averageSaleCents: 0, itemsSold: 0,
  pendingCount: 0, pendingAmountCents: 0, rejectedCount: 0, rejectedAmountCents: 0,
})

export function calendarDay(instant: string, timezone: string): string {
  const date = new Date(instant)
  if (!Number.isFinite(date.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

export function todayInTimezone(timezone: string, now = new Date()): string {
  return calendarDay(now.toISOString(), timezone)
}

export function calculateLocalSalesReport(storeId: string, day: string, timezone: string, data: ReportingData): LocalSalesReport {
  const report = emptyReport()
  const orders = data.orders.filter(order => order.store_id === storeId && calendarDay(order.client_generated_at, timezone) === day)
  if (!orders.length) return report
  const orderIds = new Set(orders.map(order => order.id))
  const outboxByOrder = new Map(data.outbox.filter(entry => entry.store_id === storeId && orderIds.has(entry.order_id)).map(entry => [entry.order_id, entry]))

  for (const order of orders) {
    const discount = order.discount_cents ?? 0
    report.grossSalesCents += order.subtotal_cents
    report.discountCents += discount
    report.netSalesCents += order.subtotal_cents - discount
    report.taxCents += order.tax_cents
    report.recordedTotalCents += order.total_cents
    report.completedOrderCount += 1

    const outbox = outboxByOrder.get(order.id)
    const rejected = order.sync_status === 'failed' || outbox?.failure_kind === 'validation'
    if (rejected) {
      report.rejectedCount += 1
      report.rejectedAmountCents += order.total_cents
    } else if (order.sync_status !== 'synced') {
      report.pendingCount += 1
      report.pendingAmountCents += order.total_cents
    }
  }

  for (const item of data.items) if (orderIds.has(item.order_id)) report.itemsSold += item.quantity
  for (const payment of data.payments) {
    if (!orderIds.has(payment.order_id)) continue
    if (payment.method === 'cash') report.cashTakingsCents += payment.amount_cents
    if (payment.method === 'card') report.cardTakingsCents += payment.amount_cents
  }
  report.averageSaleCents = report.completedOrderCount
    ? Math.floor((report.recordedTotalCents + Math.floor(report.completedOrderCount / 2)) / report.completedOrderCount)
    : 0
  return report
}
