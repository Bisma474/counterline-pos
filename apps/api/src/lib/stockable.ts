import type { PoolClient } from 'pg'

/**
 * The stockable-entity contract (Phase 2: Inventory Operations).
 *
 * Product variants do not exist anywhere in this codebase today — pos_products/pos_stock is the
 * only stockable entity table. Building a variant/attribute catalog is its own feature and out of
 * this phase's scope (see docs/phase-2-inventory-operations-plan.md). This module exists so that
 * IF variants are introduced later, extending inventory to cover them means adding one new case
 * in the two functions below — not scattering `if product... else if variant...` checks across
 * routes, services, and UI. Every inventory endpoint resolves stock through here, never by
 * querying pos_stock directly.
 */
export type StockableType = 'product'

export interface StockableRef {
  type: StockableType
  id: string
}

export function productStockable(productId: string): StockableRef {
  return { type: 'product', id: productId }
}

export interface StockableRow {
  name: string
  sku: string
  current_stock: number
  low_stock_threshold: number
}

/**
 * Resolves and row-locks the authoritative stock for a stockable entity within an already-open
 * transaction, scoped to the given store. Returns null for a cross-store or nonexistent
 * reference — never throws — so callers choose their own error message/status.
 */
export async function lockStockableForUpdate(client: PoolClient, storeId: string, ref: StockableRef): Promise<StockableRow | null> {
  if (ref.type !== 'product') throw new Error(`Unsupported stockable type: ${ref.type satisfies never}`)
  const result = await client.query<StockableRow>(
    `select p.name, p.sku, p.low_stock_threshold, s.current_stock
     from public.pos_products p
     join public.pos_stock s on s.store_id = p.store_id and s.product_id = p.id
     where p.store_id = $1 and p.id = $2
     for update of s`,
    [storeId, ref.id],
  )
  return result.rows[0] ?? null
}

export type InventoryStatus = 'normal' | 'low' | 'out' | 'oversold'

/** Same four-state model the Inventory screen displays; the existing 3-state catalog/register
 * pills (in/low/out, hardcoded threshold 5) are untouched — this is additive, not a replacement. */
export function inventoryStatus(currentStock: number, lowStockThreshold: number): InventoryStatus {
  if (currentStock < 0) return 'oversold'
  if (currentStock === 0) return 'out'
  if (currentStock <= lowStockThreshold) return 'low'
  return 'normal'
}
