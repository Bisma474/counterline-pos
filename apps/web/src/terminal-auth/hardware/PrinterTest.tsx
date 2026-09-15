import { useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import type { BrowserCapabilities, TerminalIdentity } from './browserCapabilities'
import { TestReceipt } from './TestReceipt'

export function PrinterTest({ terminal, storeName, adapter }: { terminal?: TerminalIdentity; storeName: string; adapter: BrowserCapabilities }) {
  const [at, setAt] = useState(() => adapter.now())
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  function print() {
    setError('')
    try {
      flushSync(() => { setAt(adapter.now()); setNotice('Print dialog requested. Check the physical receipt yourself; printing is not confirmed.') })
      adapter.print()
    } catch { setError('The print dialog could not be opened. Check browser printing support and your printer setup.') }
  }
  const receipt = terminal ? <TestReceipt terminal={terminal} storeName={storeName} at={at} /> : null
  return <section className="admin-panel hardware-panel" aria-labelledby="printer-heading">
    <h2 id="printer-heading">80 mm printer test</h2>
    <p>Select your receipt printer, choose 80 mm paper and 100% scale, and turn off browser headers and footers. This sample uses a 200 mm test page; paper settings depend on the printer driver.</p>
    <p>Opening or closing the print dialog does not confirm physical printing. Check the paper for readable totals, complete identity details, and unclipped edges.</p>
    {!adapter.canPrint() && <p>Browser printing is unavailable. Use a supported browser with an installed printer driver.</p>}
    {!terminal && <p>Provision this browser for the selected store to include its identity in a test receipt.</p>}
    <button type="button" className="secondary-cta" disabled={!terminal || !adapter.canPrint()} onClick={print}>Print test receipt</button>
    <p role="status" aria-live="polite">{notice}</p>
    {error && <p role="alert" className="form-notice error">{error}</p>}
    {receipt && <details><summary>Preview test receipt</summary>{receipt}</details>}
    {receipt && createPortal(<div className="terminal-test-print">{receipt}</div>, adapter.printHost())}
  </section>
}
