import { useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { readTerminal, type TerminalCache } from './cache'
import './terminal-auth.css'

const navigation = ['Dashboard', 'Sell', 'Products', 'Orders', 'Customers', 'Reports', 'Settings']

export function CashierPosLayout({ children }: { children: ReactNode }) {
  const location = useLocation()
  const [terminal, setTerminal] = useState<TerminalCache>()
  useEffect(() => { void readTerminal().then(setTerminal) }, [])
  const cashier = terminal?.employees.find(employee => employee.id === terminal.session?.employee_id)
  return <div className="cashier-pos-shell">
    <aside className="cashier-pos-sidebar">
      <Link className="cashier-pos-brand" to="/pos/register"><span>C</span> Counterline</Link>
      <nav aria-label="Cashier navigation">{navigation.map(item => item === 'Sell'
        ? <Link key={item} className={location.pathname.startsWith('/pos/') ? 'active' : ''} to="/pos/register"><span aria-hidden="true">⌁</span>{item}</Link>
        : <span key={item} className="cashier-nav-muted"><span aria-hidden="true">○</span>{item}</span>)}</nav>
      <footer><span className="cashier-online-dot" />Terminal ready<br /><small>{terminal?.device.name ?? 'Cashier terminal'}</small></footer>
    </aside>
    <main className="cashier-pos-main">
      <header className="cashier-pos-topbar"><span className="cashier-online"><i />{navigator.onLine ? 'Online' : 'Offline'}</span><span>▣ {terminal?.device.name ?? 'Terminal'}</span><span>{terminal?.device.receipt_prefix ?? 'Receipt prefix unavailable'}</span><span className="cashier-profile">{cashier?.name ?? 'Cashier'}<small>{cashier?.role ?? 'Cashier'}</small></span></header>
      {children}
      <footer className="cashier-pos-status"><span><i /> {navigator.onLine ? 'Connected' : 'Offline'}</span><span>{terminal?.device.name ?? 'Terminal'}</span><span>Receipt prefix: {terminal?.device.receipt_prefix ?? '—'}</span></footer>
    </main>
  </div>
}
