import { activeStoreId } from './catalog'
import { posDb } from './db'
import { requireSupabase } from './supabase'

export interface FinancialAccess { storeId: string; role: 'owner' | 'manager' }

function isFinancialRole(role: unknown): role is FinancialAccess['role'] {
  return role === 'owner' || role === 'manager'
}

export async function resolveFinancialAccess(): Promise<FinancialAccess> {
  const client = requireSupabase()
  const { data: sessionResult } = await client.auth.getSession()
  const user = sessionResult.session?.user
  if (!user) throw new Error('Sign in to view reporting.')
  const key = `financial_access:${user.id}`
  if (!navigator.onLine) {
    const cached = await posDb.sync_metadata.get(key)
    if (!cached) throw new Error('Connect once to validate reporting access.')
    const parsed = JSON.parse(cached.value) as FinancialAccess & { validatedAt: string }
    if (!isFinancialRole(parsed.role) || Date.now() - Date.parse(parsed.validatedAt) >= 7 * 24 * 60 * 60 * 1000) {
      throw new Error('Offline reporting authorization has expired. Connect to validate access.')
    }
    return { storeId: parsed.storeId, role: parsed.role }
  }
  const storeId = await activeStoreId()
  const { data, error } = await client.from('store_memberships').select('role').eq('user_id', user.id)
    .eq('store_id', storeId).eq('active', true).limit(1)
  if (error) throw error
  const role = data?.[0]?.role
  if (!isFinancialRole(role)) {
    await posDb.sync_metadata.delete(key)
    throw new Error('Detailed financial reporting is currently available to store owners and managers only.')
  }
  await posDb.sync_metadata.put({ key, value: JSON.stringify({ storeId, role, validatedAt: new Date().toISOString() }) })
  return { storeId, role }
}

export interface CurrentIdentity { role: 'owner' | 'manager' | 'cashier'; email: string }

function isStoreRole(role: unknown): role is CurrentIdentity['role'] {
  return role === 'owner' || role === 'manager' || role === 'cashier'
}

/**
 * Who's signed in and what their role is, for display only (e.g. the header badge) — never a
 * substitute for a server-side permission check. Unlike resolveFinancialAccess, this never
 * throws for a cashier-role member; it just reports whatever role they hold, since every screen
 * that actually needs to restrict cashiers already does so its own way (resolveFinancialAccess
 * for Reports/Inventory, requireStoreManager server-side for refund/exchange/etc).
 */
export async function resolveCurrentIdentity(): Promise<CurrentIdentity> {
  const client = requireSupabase()
  const { data: sessionResult } = await client.auth.getSession()
  const user = sessionResult.session?.user
  if (!user || !user.email) throw new Error('Sign in to see your role.')
  const key = `signed_in_identity:${user.id}`
  if (!navigator.onLine) {
    const cached = await posDb.sync_metadata.get(key)
    if (!cached) throw new Error('Connect once to load your role.')
    const parsed = JSON.parse(cached.value) as CurrentIdentity
    if (!isStoreRole(parsed.role)) throw new Error('Connect once to load your role.')
    return parsed
  }
  const storeId = await activeStoreId()
  const { data, error } = await client.from('store_memberships').select('role').eq('user_id', user.id)
    .eq('store_id', storeId).eq('active', true).limit(1)
  if (error) throw error
  const role = data?.[0]?.role
  if (!isStoreRole(role)) throw new Error('No active role for this store.')
  const identity: CurrentIdentity = { role, email: user.email }
  await posDb.sync_metadata.put({ key, value: JSON.stringify(identity) })
  return identity
}
