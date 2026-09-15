import { accessToken, configuredApiUrl } from './catalog'
import type { OutboxEntry } from './db'
import { pushOrdersForStore, retryOrderForStore, type PushReply } from './order-sync-core'

async function sendOrder(entry: OutboxEntry): Promise<PushReply> {
  const response = await fetch(`${configuredApiUrl()}/orders/push`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await accessToken()}` },
    body: entry.payload, signal: AbortSignal.timeout(20_000),
  })
  const body = await response.json().catch(() => ({})) as PushReply['body']
  return { ok: response.ok, status: response.status, body }
}

export function pushPendingOrders(storeId: string): Promise<number> {
  return pushOrdersForStore(storeId, sendOrder)
}
export function retryOrder(operationId: string, storeId: string): Promise<void> {
  return retryOrderForStore(operationId, storeId, sendOrder)
}
