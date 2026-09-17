import type { Request, Response, NextFunction } from 'express'

/**
 * MVP device-auth middleware.
 *
 * Validates `Authorization: Bearer <token>` against the DEVICE_TOKEN
 * environment variable. This is a temporary stub that will be replaced
 * by a proper device-session JWT check once Ahmed's terminal provisioning
 * is integrated.
 *
 * Security note: DEVICE_TOKEN must never be committed — use .env.local only.
 */
export function requireDeviceToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expectedToken = process.env.DEVICE_TOKEN
  if (!expectedToken) {
    // In development without a configured token, pass through with a warning.
    console.warn('[device-auth] DEVICE_TOKEN not set — skipping auth check (dev mode)')
    next()
    return
  }

  const authHeader = req.headers['authorization'] ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

  if (!token || token !== expectedToken) {
    res.status(401).json({ error: 'Unauthorized', message: 'Valid device token required.' })
    return
  }

  next()
}
