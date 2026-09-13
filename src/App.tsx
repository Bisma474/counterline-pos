import { FormEvent } from 'react'
import { Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom'

const Shell = ({ children }: { children: React.ReactNode }) => (
  <main className="auth-shell">
    <section className="brand-panel">
      <Link className="wordmark" to="/">COUNTERLINE<span>.</span></Link>
      <div className="brand-copy">
        <p className="eyebrow">RETAIL, UNINTERRUPTED</p>
        <h1>Keep the counter<br />moving.</h1>
        <p>Offline-ready tools for the people who keep a store alive.</p>
      </div>
      <div className="shift-stamp"><span>STORE MODE</span><strong>READY FOR<br />THE RUSH</strong></div>
    </section>
    <section className="form-panel">{children}</section>
  </main>
)

function SignIn() {
  const navigate = useNavigate()
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); navigate('/register') }
  return <Shell><div className="form-wrap">
    <p className="eyebrow">TEAM ACCESS</p><h2>Welcome back.</h2>
    <p className="muted">Sign in to open your register and pick up where your shift left off.</p>
    <form onSubmit={submit}><label>Email<input type="email" placeholder="you@yourstore.com" required /></label>
    <label>Password<input type="password" placeholder="Enter your password" required /></label>
    <div className="form-row"><label className="check"><input type="checkbox" /> Keep me signed in</label><a href="#support">Need help?</a></div>
    <button className="primary" type="submit">Open register <span>→</span></button></form>
    <p className="footnote">New team member? <Link to="/invite">Use your invitation</Link></p>
  </div></Shell>
}

function Invite() {
  const navigate = useNavigate()
  return <Shell><div className="form-wrap"><p className="eyebrow">JOIN A STORE</p><h2>Set up your access.</h2>
  <p className="muted">Use the invitation link your team lead sent to create your staff account.</p>
  <label>Invitation code<input placeholder="XXXX-XXXX" /></label><label>Create password<input type="password" placeholder="At least 12 characters" /></label>
  <button className="primary" onClick={() => navigate('/login')}>Create account <span>→</span></button>
  <p className="footnote"><Link to="/login">Back to sign in</Link></p></div></Shell>
}

function RegisterPreview() { return <div className="app-preview"><header><Link className="wordmark" to="/">COUNTERLINE<span>.</span></Link><div className="live-dot">OFFLINE READY</div><button className="avatar">AM</button></header>
<div className="preview-content"><div><p className="eyebrow">REGISTER 01 · MORNING SHIFT</p><h2>What’s selling?</h2><div className="product-grid">{['Cold brew','Market tote','Cinnamon roll','House blend'].map((item, index) => <button className="product" key={item}><small>0{index + 1}</small><strong>{item}</strong><span>${[4.5,18,3.75,14][index].toFixed(2)}</span></button>)}</div></div>
<aside className="cart"><p className="eyebrow">CURRENT SALE</p><h3>Your cart is clear.</h3><p>Add an item to start a sale.</p><button className="disabled">Take payment</button></aside></div></div> }

function App() { return <Routes><Route path="/" element={<Navigate to="/login" replace />} /><Route path="/login" element={<SignIn />} /><Route path="/invite" element={<Invite />} /><Route path="/register" element={<RegisterPreview />} /><Route path="*" element={<Navigate to="/login" replace />} /></Routes> }
export default App
