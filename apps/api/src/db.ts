import pg from 'pg'
import 'dotenv/config'

const { Pool } = pg

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL environment variable is required. ' +
    'Copy apps/api/.env.example to apps/api/.env.local and fill in your values.',
  )
}

/**
 * Singleton pg.Pool connected to the Supabase (or local Postgres) database.
 * Used exclusively in server-side API routes — never exported to browser code.
 */
export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})

db.on('error', (err) => {
  console.error('[db] unexpected pool error', err)
})
