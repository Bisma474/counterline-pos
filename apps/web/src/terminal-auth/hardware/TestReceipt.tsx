import type { TerminalIdentity } from './browserCapabilities'

export const sampleReceipt = {
  lines: [{ name: 'Sample mug', quantity: 1, unitCents: 1800 }, { name: 'Sample tea', quantity: 2, unitCents: 650 }],
  taxCents: 155,
  tenderCents: 4000,
} as const
export const sampleSubtotalCents = sampleReceipt.lines.reduce((sum, line) => sum + line.quantity * line.unitCents, 0)
export const sampleTotalCents = sampleSubtotalCents + sampleReceipt.taxCents
export function formatTestCents(cents: number) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('Test amounts must be nonnegative integer cents.')
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
}
export function TestReceipt({ terminal, storeName, at }: { terminal: TerminalIdentity; storeName: string; at: number }) {
  return <article className="hardware-test-receipt" aria-label="Test receipt preview">
    <h3>Counterline</h3>
    <p className="receipt-test-label">TEST RECEIPT — NOT A SALE</p>
    <p>{storeName}<br />{terminal.name}</p>
    <dl className="receipt-identity">
      <div><dt>Device ID</dt><dd>{terminal.id}</dd></div>
      <div><dt>Store ID</dt><dd>{terminal.storeId}</dd></div>
      <div><dt>Receipt prefix</dt><dd>{terminal.receiptPrefix}</dd></div>
    </dl>
    <p>{new Date(at).toLocaleString()}<br />Sample currency: USD</p>
    <table><caption>Sample items</caption><thead><tr><th scope="col">Item</th><th scope="col">Qty</th><th scope="col">USD</th></tr></thead>
      <tbody>{sampleReceipt.lines.map(line => <tr key={line.name}><td>{line.name}<small>{formatTestCents(line.unitCents)} each</small></td><td>{line.quantity}</td><td>{formatTestCents(line.unitCents * line.quantity)}</td></tr>)}</tbody>
    </table>
    <dl className="receipt-totals">
      <div><dt>Subtotal</dt><dd>{formatTestCents(sampleSubtotalCents)}</dd></div>
      <div><dt>Sample tax</dt><dd>{formatTestCents(sampleReceipt.taxCents)}</dd></div>
      <div className="receipt-total"><dt>Total USD</dt><dd>{formatTestCents(sampleTotalCents)}</dd></div>
      <div><dt>Sample cash tender</dt><dd>{formatTestCents(sampleReceipt.tenderCents)}</dd></div>
      <div><dt>Sample change</dt><dd>{formatTestCents(sampleReceipt.tenderCents - sampleTotalCents)}</dd></div>
    </dl>
    <p>No sale or payment recorded.<br />No receipt number allocated.<br />Hardware alignment test · 80 mm paper</p>
  </article>
}
