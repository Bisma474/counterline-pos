import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { catalogRouter } from './routes/catalog.js'
import { ordersRouter } from './routes/orders.js'

const app = express()
const PORT = Number(process.env.PORT ?? 3001)

// Middleware
app.use(cors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173' }))
app.use(express.json())

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() })
})

// ── New routes (feat/catalog-checkout-sync) ─────────────────────────────────
app.use('/catalog', catalogRouter)
app.use('/orders', ordersRouter)
// ────────────────────────────────────────────────────────────────────────────

// Existing stub routes — untouched
app.post('/devices/provision', (_req, res) => {
  res.status(501).json({ error: 'Not implemented — terminal provisioning is a future task.' })
})
app.use('/auth', (_req, res) => {
  res.status(501).json({ error: 'Not implemented — auth is handled by Supabase.' })
})
app.use('/sync', (_req, res) => {
  res.status(501).json({ error: 'Not implemented — pull sync is a future task.' })
})

app.listen(PORT, () => {
  console.log(`[api] Counterline API listening on http://localhost:${PORT}`)
})

export default app
