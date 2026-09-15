import { accessToken, configuredApiUrl } from './catalog'
import { posDb, type OutboxEntry } from './db'

const owner = crypto.randomUUID()
function nextAttempt(attempt: number): string {
  const delaySeconds = Math.min(300, 5 * 2 ** Math.min(attempt, 6))
  return new Date(Date.now() + delaySeconds * 1000).toISOString()
}
async function claimOne(): Promise<OutboxEntry | undefined> {
  return posDb.transaction('rw', posDb.outbox, async () => {
    const now = new Date().toISOString()
    const entries = await posDb.outbox.where('status').anyOf('pending', 'failed').toArray()
    const entry = entries.find(row => (row.status === 'pending' || row.failure_kind === 'connectivity') &&
      row.next_attempt_at <= now && (!row.lease_expires_at || row.lease_expires_at < now))
    if (!entry?.id) return undefined
    const claimed = { ...entry, lease_owner: owner, lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
      attempt_count: entry.attempt_count + 1 }
    await posDb.outbox.put(claimed)
    return claimed
  })
}
async function finish(entry: OutboxEntry, accepted: boolean, code: string | null, message: string | null, checkpoint: string | null, failureKind: OutboxEntry['failure_kind']) {
  await posDb.transaction('rw', posDb.outbox, posDb.orders, posDb.stock_adjustments, async () => {
    const current = await posDb.outbox.get(entry.id!)
    if (!current || current.lease_owner !== owner) return
    const status = accepted ? 'synced' : 'failed'
    await posDb.outbox.put({ ...current, status, failure_kind: failureKind,
      reason_code: code, failure_reason: message, accepted_checkpoint: checkpoint,
      lease_owner: null, lease_expires_at: null,
      next_attempt_at: failureKind === 'connectivity' ? nextAttempt(current.attempt_count) : current.next_attempt_at })
    await posDb.orders.update(entry.order_id, { sync_status: accepted ? 'synced' : failureKind === 'validation' ? 'failed' : 'pending', accepted_checkpoint: checkpoint,
      failure_reason: message })
    if (accepted) {
      const adjustments = await posDb.stock_adjustments.where('operation_id').equals(entry.operation_id).toArray()
      for (const adjustment of adjustments) await posDb.stock_adjustments.put({ ...adjustment, accepted_checkpoint: checkpoint })
    }
  })
}
export async function pushPendingOrders(): Promise<number> {
  if (!navigator.onLine) return 0
  let accepted = 0
  for (let count = 0; count < 100; count++) {
    const entry = await claimOne()
    if (!entry) break
    try {
      const response = await fetch(`${configuredApiUrl()}/orders/push`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await accessToken()}` },
        body: entry.payload,
      })
      const body = await response.json() as { status?: string; operation_id?: string; accepted_checkpoint?: string; code?: string; message?: string }
      if (response.ok && body.status === 'accepted' && body.operation_id === entry.operation_id &&
        typeof body.accepted_checkpoint === 'string') {
        await finish(entry, true, null, null, body.accepted_checkpoint, null)
        accepted += 1
      } else if (response.status === 401 || response.status === 403) {
        await finish(entry, false, body.code ?? 'authentication_required', body.message ?? 'Sign in to resume sync.', null, 'authentication')
        break
      } else if (response.status === 409 || response.status === 422) {
        await finish(entry, false, body.code ?? 'validation_failed', body.message ?? 'Sale needs review.', null, 'validation')
      } else {
        await finish(entry, false, body.code ?? 'server_unavailable', body.message ?? 'Sync will retry later.', null, 'connectivity')
        break
      }
    } catch {
      await finish(entry, false, 'connectivity_timeout', 'Could not reach the server. Sync will retry.', null, 'connectivity')
      break
    }
  }
  return accepted
}
export async function retryOrder(operationId: string) {
  const entry = await posDb.outbox.where('operation_id').equals(operationId).first()
  if (!entry || entry.status === 'synced') return
  await posDb.outbox.update(entry.id!, { status: 'pending', failure_kind: null, reason_code: null,
    failure_reason: null, next_attempt_at: new Date().toISOString(), lease_owner: null, lease_expires_at: null })
  await posDb.orders.update(entry.order_id, { sync_status: 'pending', failure_reason: null })
  await pushPendingOrders()
}
