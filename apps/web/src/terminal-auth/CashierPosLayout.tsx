import { useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { readTerminal, type TerminalCache } from './cache'
import './terminal-auth.css'
import '../receipts/receipts.css'

const navigation = [
  { label: 'Dashboard', to: '/pos/dashboard', icon: '⌂' },
  { label: 'Sell', to: '/pos/register', icon: '⌁' },
  { label: 'Products', icon: '○' },
  { label: 'Orders', to: '/pos/orders', icon: '○' },
  { label: 'Customers', to: '/pos/customers', icon: '♧' },
  { label: 'Settings', icon: '○' },
]

export function CashierPosLayout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const [terminal, setTerminal] = useState<TerminalCache>()
  useEffect(() => { void readTerminal().then(setTerminal) }, [])
  const cashier = terminal?.employees.find(employee => employee.id === terminal.session?.employee_id)
  return <div className="cashier-pos-shell">
    <aside className="cashier-pos-sidebar">
      <Link className="cashier-pos-brand" to="/pos/register"><span>C</span> Counterline</Link>
      <nav aria-label="Cashier navigation">{navigation.map(item => {
        const active = item.label === 'Sell'
          ? ['/pos/register', '/pos/payment'].includes(pathname)
          : item.label === 'Orders'
            ? pathname.startsWith('/pos/orders')
            : pathname === item.to
        return item.to
          ? <Link key={item.label} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined} to={item.to}><span aria-hidden="true">{item.icon}</span>{item.label}</Link>
          : <span key={item.label} className="cashier-nav-muted"><span aria-hidden="true">{item.icon}</span>{item.label}</span>
      })}</nav>
      <footer><span className="cashier-online-dot" />Terminal ready<br /><small>{terminal?.device.name ?? 'Cashier terminal'}</small></footer>
    </aside>
    <main className="cashier-pos-main">
      <header className="cashier-pos-topbar"><span className="cashier-online"><i />{navigator.onLine ? 'Online' : 'Offline'}</span><span>▣ {terminal?.device.name ?? 'Terminal'}</span><span>{terminal?.device.receipt_prefix ?? 'Receipt prefix unavailable'}</span><span className="cashier-profile">{cashier?.name ?? 'Cashier'}<small>{cashier?.role ?? 'Cashier'}</small></span></header>
      <nav className="cashier-pos-mobile-nav" aria-label="Cashier navigation"><Link className={pathname === '/pos/register' ? 'active' : ''} to="/pos/register">Sell</Link><Link className={pathname === '/pos/customers' ? 'active' : ''} to="/pos/customers">Customers</Link></nav>
      {children}
      <footer className="cashier-pos-status"><span><i /> {navigator.onLine ? 'Connected' : 'Offline'}</span><span>{terminal?.device.name ?? 'Terminal'}</span><span>Receipt prefix: {terminal?.device.receipt_prefix ?? '—'}</span></footer>
    </main>
    <nav className="cashier-mobile-nav" aria-label="Cashier navigation"><Link className={pathname === '/pos/dashboard' ? 'active' : ''} to="/pos/dashboard"><span aria-hidden="true">⌂</span>Dashboard</Link><Link className={pathname === '/pos/register' || pathname === '/pos/payment' ? 'active' : ''} to="/pos/register"><span aria-hidden="true">⌁</span>Sell</Link></nav>
  </div>
}
