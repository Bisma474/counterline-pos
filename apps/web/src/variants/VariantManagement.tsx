import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { accessToken, configuredApiUrl, loadCatalog } from '../lib/catalog'
import type { LocalCategory, LocalTaxRate } from '../lib/db'
import { formatCents, parseCents } from '../../../../packages/domain/src/money'
import { optionLabel } from '../../../../packages/domain/src/variants'
import './variants.css'

interface Parent { id: string; name: string; revision: string }
interface Variant { id: string; parent_product_id: string; name: string; option_values: Record<string,string>; sku: string; barcode: string | null; unit_price_cents: number; current_stock: number; active: boolean; is_draft: boolean; revision: string; category_id: string | null; tax_rate_id: string | null }
const empty = () => ({ sku:'', barcode:'', price:'', stock:'0', category:'', tax:'', options:[{ name:'Size', value:'' },{ name:'Color', value:'' }] })

export function VariantManagement({ storeId, currency, categories, taxRates }: { storeId: string; currency: string; categories: LocalCategory[]; taxRates: LocalTaxRate[] }) {
  const [parents,setParents] = useState<Parent[]>([])
  const [variants,setVariants] = useState<Variant[]>([])
  const [parentId,setParentId] = useState('')
  const [parentName,setParentName] = useState('')
  const [rename,setRename] = useState('')
  const [form,setForm] = useState(empty)
  const [editing,setEditing] = useState<Variant | null>(null)
  const [busy,setBusy] = useState(false)
  const [loading,setLoading] = useState(true)
  const [error,setError] = useState('')
  const [notice,setNotice] = useState('')
  const request = useCallback(async (path: string, method='GET', data?: object) => {
    const response = await fetch(`${configuredApiUrl()}/catalog${path}${method==='GET' ? `?store_id=${encodeURIComponent(storeId)}` : ''}`, {
      method, headers: { Authorization:`Bearer ${await accessToken()}`, 'Content-Type':'application/json' },
      body: data ? JSON.stringify({ ...data, store_id:storeId }) : undefined,
      signal: AbortSignal.timeout(20_000),
    })
    const body = await response.json() as { parents?: Parent[]; variants?: Variant[]; parent?: Parent; message?: string }
    if (!response.ok) throw new Error(body.message ?? 'Unable to save variants.')
    return body
  },[storeId])
  const reload = useCallback(async () => {
    const result = await request('/product-parents')
    setParents(result.parents ?? []); setVariants(result.variants ?? [])
  },[request])
  useEffect(() => {
    let active = true
    setLoading(true)
    void request('/product-parents').then(data => { if(active){setParents(data.parents ?? []);setVariants(data.variants ?? [])} })
      .catch(reason => {if(active)setError(reason instanceof Error ? reason.message : 'Unable to load variants.')})
      .finally(()=>{if(active)setLoading(false)})
    return ()=>{active=false}
  },[request])
  const run = async (work:()=>Promise<void>, message:string) => {
    setBusy(true);setError('');setNotice('')
    try {
      if (!navigator.onLine) throw new Error('Connect to manage variants. Cashiers can continue using the saved catalog.')
      await work(); await reload(); setNotice(message)
      try { await loadCatalog(storeId) } catch { setNotice(`${message} Local catalog refresh is pending. Resolve queued sync and refresh the catalog before selling these changes.`) }
    } catch(reason){setError(reason instanceof Error ? reason.message : 'Unable to save variants.')}
    finally{setBusy(false)}
  }
  const selectParent = (id:string) => {setParentId(id);setRename(parents.find(p=>p.id===id)?.name ?? '');setEditing(null);setForm(empty())}
  const save = (event:FormEvent) => {
    event.preventDefault()
    void run(async()=>{
      const entries = form.options.filter(option=>option.name.trim() || option.value.trim())
      if (entries.some(option=>!option.name.trim() || !option.value.trim())) throw new Error('Complete each option name and value, or remove the unused option.')
      if (new Set(entries.map(option=>option.name.trim().toLowerCase())).size!==entries.length) throw new Error('Option names must be unique.')
      const body = { parent_product_id:parentId, sku:form.sku, barcode:form.barcode || null, unit_price_cents:parseCents(form.price),
        option_values:Object.fromEntries(entries.map(option=>[option.name,option.value])), category_id:form.category || null, tax_rate_id:form.tax || null,
        active:editing?.active ?? false, ...(editing ? {revision:editing.revision} : {initial_stock:Number(form.stock)}) }
      await request(editing ? `/variants/${editing.id}` : '/variants',editing ? 'PATCH':'POST',body)
      setEditing(null);setForm(empty())
    },editing ? 'Variant saved. Historical sales are unchanged.' : 'Draft variant created. Review it below, then activate it for sale.')
  }
  const changeState = (variant:Variant) => void run(async()=>{
    await request(`/variants/${variant.id}`,'PATCH',{...variant,active:!variant.active})
    if(editing?.id===variant.id){setEditing(null);setForm(empty())}
  },variant.active ? 'Variant deactivated. Terminals receive this change on their next successful catalog refresh.' : 'Variant activated. It can no longer be deleted; deactivate it if needed.')
  const selected = variants.filter(v=>v.parent_product_id===parentId)
  return <section className="variant-management" aria-labelledby="variant-management-title">
    <h2 id="variant-management-title">Products with variants</h2>
    <p>Create a parent such as T-Shirt, then add independently priced and stocked variants. Management requires an online owner or manager.</p>
    {loading && <p role="status">Loading variants…</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" disabled={busy} onClick={()=>void run(reload,'Variants reloaded.')}>Reload variants</button></div>}
    <p role="status">{notice}</p>
    <form onSubmit={event=>{event.preventDefault();void run(async()=>{
      const result=await request('/product-parents','POST',{name:parentName});setParentName('');setParentId(result.parent!.id);setRename(result.parent!.name);setEditing(null);setForm(empty())
    },'Parent product created. Add its first draft variant.')}}>
      <label>New parent product name<input value={parentName} required maxLength={80} onChange={e=>setParentName(e.target.value)} placeholder="T-Shirt" /></label>
      <button className="pc-btn-primary" disabled={busy || loading}>Create parent product</button>
    </form>
    {!loading && !parents.length && <p>No parent products yet. Ordinary products continue to sell individually.</p>}
    {parents.length>0 && <label>Manage parent product<select value={parentId} disabled={busy} onChange={e=>selectParent(e.target.value)}><option value="">Choose a parent</option>{parents.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
    {parentId && <>
      <form onSubmit={event=>{event.preventDefault();void run(async()=>{await request(`/product-parents/${parentId}`,'PATCH',{name:rename,revision:parents.find(p=>p.id===parentId)?.revision})},'Parent renamed. Historical receipts are unchanged.')}}>
        <label>Parent name<input required maxLength={80} value={rename} onChange={e=>setRename(e.target.value)} /></label><button disabled={busy}>Save parent name</button>
      </form>
      <h3>{editing ? 'Edit variant' : 'Add draft variant'}</h3>
      <form onSubmit={save} className="variant-form"><fieldset disabled={busy}>
        <div className="variant-form-grid"><label>Variant SKU<input required maxLength={80} value={form.sku} onChange={e=>setForm({...form,sku:e.target.value})} /></label>
        <label>Variant barcode (optional)<input maxLength={80} value={form.barcode} onChange={e=>setForm({...form,barcode:e.target.value})} /></label>
        <label>Variant price ({currency})<input required inputMode="decimal" value={form.price} onChange={e=>setForm({...form,price:e.target.value})} /></label>
        {!editing && <label>Initial variant stock<input required type="number" min="0" max="1000000" step="1" value={form.stock} onChange={e=>setForm({...form,stock:e.target.value})} /></label>}
        <label>Variant category<select value={form.category} onChange={e=>setForm({...form,category:e.target.value})}><option value="">Uncategorized</option>{categories.filter(c=>c.active).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>Variant tax rate<select value={form.tax} onChange={e=>setForm({...form,tax:e.target.value})}><option value="">Tax exempt</option>{taxRates.filter(t=>t.active).map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label></div>
        <p>Options can be size, color, weight, pack size, or another label. Up to four per variant.</p>
        {form.options.map((option,index)=><div className="variant-option-row" key={index}>
          <label>Option {index+1} name<input required maxLength={24} value={option.name} onChange={e=>setForm({...form,options:form.options.map((o,i)=>i===index?{...o,name:e.target.value}:o)})} /></label>
          <label>Option {index+1} value<input required maxLength={40} value={option.value} onChange={e=>setForm({...form,options:form.options.map((o,i)=>i===index?{...o,value:e.target.value}:o)})} /></label>
          <button type="button" disabled={form.options.length===1} onClick={()=>setForm({...form,options:form.options.filter((_,i)=>i!==index)})}>Remove option {index+1}</button>
        </div>)}
        <div className="variant-actions"><button type="button" disabled={form.options.length===4} onClick={()=>setForm({...form,options:[...form.options,{name:'',value:''}]})}>Add option</button>
        <button className="pc-btn-primary">{editing ? 'Save variant' : 'Create draft variant'}</button>
        {editing && <button type="button" onClick={()=>{setEditing(null);setForm(empty())}}>Cancel editing</button>}</div>
      </fieldset></form>
      <h3>Variants</h3>{!selected.length && <p>No variants for this parent yet.</p>}
      <div className="variant-list">{selected.map(v=><article key={v.id}>
        <h4>{optionLabel(v.option_values)}</h4><p>{v.sku} · {formatCents(v.unit_price_cents,currency)} · Server stock: {v.current_stock}</p>
        <p>{v.barcode ? `Barcode: ${v.barcode}` : 'No barcode'} · {v.is_draft ? 'Draft — not sellable' : v.active ? 'Active' : 'Inactive'}</p>
        <div className="variant-actions"><button type="button" disabled={busy} onClick={()=>{setEditing(v);setForm({sku:v.sku,barcode:v.barcode ?? '',price:(v.unit_price_cents/100).toFixed(2),stock:String(v.current_stock),category:v.category_id ?? '',tax:v.tax_rate_id ?? '',options:Object.entries(v.option_values).map(([name,value])=>({name,value}))})}}>Edit {v.sku}</button>
        <button type="button" disabled={busy} onClick={()=>changeState(v)}>{v.active ? 'Deactivate' : 'Activate'} {v.sku}</button>
        {v.is_draft && <button type="button" disabled={busy} onClick={()=>{if(window.confirm(`Remove draft ${v.sku}?`))void run(async()=>{await request(`/variants/${v.id}`,'DELETE',{revision:v.revision});if(editing?.id===v.id){setEditing(null);setForm(empty())}},'Draft removed.')}}>Remove draft {v.sku}</button>}</div>
      </article>)}</div>
    </>}
  </section>
}
