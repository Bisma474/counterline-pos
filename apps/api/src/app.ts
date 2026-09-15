import express from 'express'
import { catalogRouter } from './routes/catalog.js'
import { ordersRouter } from './routes/orders.js'
import { terminalAuthRouter, type TerminalAuthOptions } from './terminal-auth/routes.js'

export function createApp(options: TerminalAuthOptions) {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '64kb' }))
  app.get('/health', (_req, res) => { res.json({ status: 'ok', ts: new Date().toISOString() }) })
  app.use(terminalAuthRouter(options))
  app.use('/catalog', catalogRouter)
  app.use('/orders', ordersRouter)
  return app
}
