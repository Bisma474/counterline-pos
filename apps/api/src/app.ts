import express from 'express'
import { z } from 'zod'

const deviceIdSchema = z.string().uuid()

export function createApp() {
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.get('/health', (_request, response) => response.json({ status: 'ok' }))
  app.post('/devices/provision', (_request, response) => response.status(501).json({ code: 'not_configured', message: 'Device provisioning requires the offline POS database migration and server configuration.' }))
  app.post('/auth/login', (_request, response) => response.status(501).json({ code: 'not_configured', message: 'Employee PIN authentication is not configured yet.' }))
  app.post('/auth/refresh', (_request, response) => response.status(501).json({ code: 'not_configured', message: 'Device refresh is not configured yet.' }))
  app.post('/sync/push', (_request, response) => response.status(501).json({ code: 'not_configured', message: 'Sync push is not configured yet.' }))
  app.get('/sync/pull', (_request, response) => response.status(501).json({ code: 'not_configured', message: 'Sync pull is not configured yet.' }))
  app.post('/sync/snapshot', (_request, response) => response.status(501).json({ code: 'not_configured', message: 'Snapshot creation is not configured yet.' }))
  app.get('/sync/status', (request, response) => { const parsed = deviceIdSchema.safeParse(request.query.deviceId); if (!parsed.success) return response.status(400).json({ code: 'invalid_device_id' }); return response.status(501).json({ code: 'not_configured', message: 'Sync status is not configured yet.' }) })
  app.get('/devices/:id/orders', (request, response) => { const parsed = deviceIdSchema.safeParse(request.params.id); if (!parsed.success) return response.status(400).json({ code: 'invalid_device_id' }); return response.status(501).json({ code: 'not_configured', message: 'Order restoration is not configured yet.' }) })
  return app
}
