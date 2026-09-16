import { useRef, useState, type FormEvent } from 'react'

export function ScannerTest({ now }: { now: () => number }) {
  const [draft, setDraft] = useState('')
  const [capture, setCapture] = useState<{ value: string; at: number }>()
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!draft.trim()) { setError('Scan or type a value before pressing Enter.'); return }
    if (draft.length > 512) { setError('Test values must be 512 characters or fewer.'); return }
    setCapture({ value: draft, at: now() }); setDraft(''); setError('')
  }
  return <section className="admin-panel hardware-panel" aria-labelledby="scanner-heading">
    <h2 id="scanner-heading">Keyboard scanner test</h2>
    <p>Connect an HID keyboard scanner, focus the field below, and scan a barcode. Configure the scanner to send Enter at the end. You can also type a test value and press Enter.</p>
    <form onSubmit={submit}>
      <label htmlFor="scanner-test-input">Scan test value</label>
      <input id="scanner-test-input" ref={input} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }} autoComplete="off" spellCheck={false} aria-describedby="scanner-privacy" />
      <button type="submit" className="secondary-cta">Capture test value</button>
      <button type="button" className="text-button" onClick={() => { setDraft(''); setCapture(undefined); setError(''); input.current?.focus() }}>Clear scanner test</button>
    </form>
    <p id="scanner-privacy" className="hardware-help">Test values stay on this screen only. They are not saved, sent to the server, or used to look up products.</p>
    <div role="status" aria-live="polite" aria-atomic="true">
      {capture ? <><p>Scan captured.</p><dl className="hardware-details">
        <div><dt>Captured value</dt><dd className="scanner-value">{capture.value}</dd></div>
        <div><dt>Character count</dt><dd>{Array.from(capture.value).length}</dd></div>
        <div><dt>Captured at</dt><dd><time dateTime={new Date(capture.at).toISOString()}>{new Date(capture.at).toLocaleString()}</time></dd></div>
      </dl></> : <p>No scan captured yet.</p>}
    </div>
    {error && <p role="alert" className="form-notice error">{error}</p>}
  </section>
}
