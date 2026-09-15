import express from 'express'
import { terminalAuthRouter, type TerminalAuthOptions } from './terminal-auth/routes.js'

export function createApp(options: TerminalAuthOptions) {
  const app = express()
  app.disable('x-powered-by')
  app.use(terminalAuthRouter(options))
  return app
}
