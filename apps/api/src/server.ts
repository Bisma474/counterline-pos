import { Pool } from 'pg'
import { createApp } from './app.js'

function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
const pool = new Pool({ connectionString: required('DATABASE_URL'), max: 10 })
createApp({ pool, origin: required('WEB_ORIGIN'), supabaseUrl: required('SUPABASE_URL'), supabaseKey: required('SUPABASE_PUBLISHABLE_KEY'), secureCookies: process.env.NODE_ENV !== 'development' })
  .listen(Number(process.env.PORT ?? 3001), '127.0.0.1')
