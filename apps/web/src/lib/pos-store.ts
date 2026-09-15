/**
 * apps/web/src/lib/pos-store.ts
 *
 * Zustand cart store for the POS register.
 * Holds the current cart, store context, and sync state.
 * All monetary values are integer cents — never float.
 */
import { create } from 'zustand'
import { calculateLine, sumLines } from '../../../../packages/domain/src/money'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CartItem {
  productId: string
  name: string
  sku: string
  unitPriceCents: number     // integer cents
  taxRateBps: number
  catalogVersion: number
  quantity: number
}

export interface CartTotals {
  subtotalCents: number
  taxCents: number
  totalCents: number
}

export type SyncStatus = 'idle' | 'syncing' | 'error'

export interface PosStore {
  // Store context (set on register boot)
  storeId: string
  storeName: string
  setStoreContext: (storeId: string, storeName: string) => void

  // Cart
  items: CartItem[]
  addItem: (product: Omit<CartItem, 'quantity'>) => void
  removeItem: (productId: string) => void
  incrementItem: (productId: string) => void
  decrementItem: (productId: string) => void
  clearCart: () => void

  // Totals (derived)
  totals: () => CartTotals

  // Sync status
  syncStatus: SyncStatus
  setSyncStatus: (status: SyncStatus) => void
  catalogStatus: 'unknown' | 'ready' | 'unavailable'
  setCatalogStatus: (status: 'unknown' | 'ready' | 'unavailable') => void
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const usePosStore = create<PosStore>((set, get) => ({
  storeId: '',
  storeName: '',
  setStoreContext: (storeId, storeName) => set({ storeId, storeName }),

  items: [],

  addItem: (product) =>
    set((state) => {
      const existing = state.items.find((i) => i.productId === product.productId)
      if (existing) {
        return {
          items: state.items.map((i) =>
            i.productId === product.productId
              ? { ...i, quantity: Math.min(10_000, i.quantity + 1) }
              : i,
          ),
        }
      }
      return { items: [...state.items, { ...product, quantity: 1 }] }
    }),

  removeItem: (productId) =>
    set((state) => ({ items: state.items.filter((i) => i.productId !== productId) })),

  incrementItem: (productId) =>
    set((state) => ({
      items: state.items.map((i) =>
        i.productId === productId ? { ...i, quantity: Math.min(10_000, i.quantity + 1) } : i,
      ),
    })),

  decrementItem: (productId) =>
    set((state) => {
      const item = state.items.find((i) => i.productId === productId)
      if (!item) return state
      if (item.quantity <= 1) {
        return { items: state.items.filter((i) => i.productId !== productId) }
      }
      return {
        items: state.items.map((i) =>
          i.productId === productId ? { ...i, quantity: i.quantity - 1 } : i,
        ),
      }
    }),

  clearCart: () => set({ items: [] }),

  totals: () => {
    const { items } = get()
    if (items.length === 0) {
      return { subtotalCents: 0, taxCents: 0, totalCents: 0 }
    }
    const lines = items.map((item) =>
      calculateLine(item.unitPriceCents, item.quantity, item.taxRateBps),
    )
    return sumLines(lines)
  },

  syncStatus: 'idle',
  setSyncStatus: (status) => set({ syncStatus: status }),
  catalogStatus: 'unknown',
  setCatalogStatus: (status) => set({ catalogStatus: status }),
}))
