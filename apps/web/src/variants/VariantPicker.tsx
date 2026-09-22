import { useEffect, useRef } from 'react'
import type { LocalProduct } from '../lib/db'
import { formatCents } from '../../../../packages/domain/src/money'
import { optionLabel } from '../../../../packages/domain/src/variants'
import './variants.css'

export function VariantPicker({ products, stock, currency, onSelect, onClose }: {
  products: LocalProduct[]; stock: Record<string,number>; currency: string
  onSelect: (product: LocalProduct) => void; onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close() }, [])
  return <dialog ref={dialog} className="variant-picker" aria-labelledby="variant-picker-title" onCancel={event=>{event.preventDefault();onClose()}}>
    <h2 id="variant-picker-title">Choose a variant</h2><p>{products[0]?.parent_name}</p>
    {!products.length && <p role="status">No active variants are available. Close this selection and refresh the catalog.</p>}
    <div className="variant-choices">{products.map(product => <button type="button" key={product.id} onClick={() => onSelect(product)}>
      <strong>{optionLabel(product.option_values ?? {}) || product.name}</strong><span>{product.sku}</span>
      <span>{formatCents(product.unit_price_cents,currency)} · {stock[product.id] ?? 0} in stock</span>
    </button>)}</div><button type="button" className="secondary-cta" onClick={onClose}>Cancel selection</button>
  </dialog>
}
