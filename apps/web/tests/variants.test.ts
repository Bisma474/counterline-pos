import 'fake-indexeddb/auto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { posDb } from '../src/lib/db'
import { completeLocalSale } from '../src/lib/checkout'
import { variantName, variantOptions } from '../../../packages/domain/src/variants'
import { calculateTopProducts, todayInTimezone } from '../src/lib/reporting'
import type { CartItem } from '../src/lib/pos-store'

test('variant option validation rejects duplicate keys, missing values, excessive fields and names', () => {
  assert.deepEqual(variantOptions({Size:' Small ',Color:'Black'}),{Color:'Black',Size:'Small'})
  assert.throws(()=>variantOptions({Size:'S',' size ':'L'}),/unique/)
  assert.throws(()=>variantOptions({Size:''}),/characters/)
  assert.throws(()=>variantOptions({a:'1',b:'2',c:'3',d:'4',e:'5'}),/four/)
  assert.throws(()=>variantName('x'.repeat(80),{Color:'x'.repeat(100)}),/160/)
})

test('ordinary products and variants share checkout while preserving independent stock and immutable option snapshots', async () => {
  await posDb.delete();await posDb.open()
  try {
    await posDb.store_config.put({id:'store',store_id:'store',name:'Store',timezone:'UTC',currency:'USD',catalog_version:1})
    const name=variantName('T-Shirt',variantOptions({Size:'Small',Color:'Black'}))
    const product={id:'small',store_id:'store',name,sku:'SMALL',barcode:'991001',unit_price_cents:1200,active:true,revision:1,parent_product_id:'parent',parent_name:'T-Shirt',option_values:{Size:'Small',Color:'Black'},is_draft:false,category_id:null,tax_rate_id:null}
    await posDb.products.bulkPut([product,{...product,id:'large',sku:'LARGE',barcode:'991002',name:variantName('T-Shirt',{Size:'Large',Color:'White'}),unit_price_cents:1500,option_values:{Size:'Large',Color:'White'}}])
    await posDb.server_stock.bulkPut([{product_id:'small',current_stock:1000,updated_at:'2026-09-15T09:00:00.000Z'},{product_id:'large',current_stock:1000,updated_at:'2026-09-15T09:00:00.000Z'},{product_id:'ordinary',current_stock:1000,updated_at:'2026-09-15T09:00:00.000Z'}])
    const item:CartItem={storeId:'store',productId:'small',parentProductId:'parent',name,sku:'SMALL',unitPriceCents:1200,taxRateBps:0,catalogVersion:1,quantity:1}
    await completeLocalSale([item],'store','cash',1200,null)
    await completeLocalSale([{...item,productId:'large',name:'T-Shirt — Size: Large / Color: White',sku:'LARGE',unitPriceCents:1500}],'store','cash',1500,null)
    await completeLocalSale([{...item,parentProductId:null,productId:'ordinary',name:'Mug',sku:'MUG',unitPriceCents:500}],'store','cash',500,null)
    assert.equal((await posDb.stock_adjustments.where('product_id').equals('small').toArray())[0].delta,-1)
    assert.equal((await posDb.stock_adjustments.where('product_id').equals('large').toArray())[0].delta,-1)
    const before=await posDb.order_items.toArray()
    await posDb.products.update('small',{name:'Renamed',option_values:{Color:'Navy',Size:'Small'},sku:'NEW',unit_price_cents:1900,active:false})
    assert.deepEqual(await posDb.order_items.toArray(),before)
    await assert.rejects(completeLocalSale([item],'store','cash',1200,null),/no longer available/)
    await posDb.products.update('small',{active:true,is_draft:true})
    await assert.rejects(completeLocalSale([item],'store','cash',1200,null),/no longer available/)
    assert.equal(await posDb.orders.count(),3)
    assert.equal((await posDb.sync_metadata.get('receipt_seq:store'))?.value,'3')
    const report=calculateTopProducts(before,await posDb.orders.toArray(),'store',todayInTimezone('UTC'),'UTC',10)
    assert.equal(report.find(row=>row.productId==='small')?.name,name)
    assert.equal(report.filter(row=>['small','large'].includes(row.productId)).length,2)
  } finally {await posDb.delete()}
})
