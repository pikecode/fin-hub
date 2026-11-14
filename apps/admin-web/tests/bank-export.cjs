const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const path = require('node:path');
const out = { exports: {} };
new Function('exports',ts.transpileModule(fs.readFileSync(path.join(__dirname,'../app/bank/export.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText)(out.exports);
const {collectBankExport,bankExportCsv}=out.exports;
(async()=>{
 const rows=Array.from({length:254},(_,i)=>({id:String(i),store_id:'store',occurred_at:'2026-09-01',direction:'expense',amount:'300.00',payment_status:'paid',counterparty_name:'=HYPERLINK("bad")',matched_amount:'0',summary:'中文,"测试"\n换行'}));
 const calls=[];
 const result=await collectBankExport(async query=>{const p=new URLSearchParams(query);calls.push(p);const start=(Number(p.get('page'))-1)*200;return {items:rows.slice(start,start+200),total:254,page:Number(p.get('page')),page_size:200};},'?store_id=store&occurred_from=2026-09-01&occurred_to=2026-10-01&direction=expense');
 assert.equal(result.length,254);assert.equal(result[253].id,'253');assert.equal(calls.length,2);
 for(const p of calls){assert.equal(p.get('store_id'),'store');assert.equal(p.get('occurred_to'),'2026-10-01');assert.equal(p.get('direction'),'expense');assert.equal(p.get('page_size'),'200');}
 const csv=bankExportCsv(result,new Map([['store','阳光城']]));assert.ok(csv.startsWith('\ufeff'));assert.ok(csv.includes('阳光城'));assert.ok(csv.includes("'=HYPERLINK"));assert.ok(csv.includes('""测试""'));assert.ok(csv.includes('"253"'));
 await assert.rejects(collectBankExport(async q=>({items:rows.slice(0,200),total:new URLSearchParams(q).get('page')==='1'?254:255}),'?'),/变动/);
 await assert.rejects(collectBankExport(async()=>({items:rows.slice(0,200),total:254}),'?'),/顺序/);
 assert.equal((await collectBankExport(async()=>({items:[],total:0}),'?')).length,0);
 console.log('Bank export: 254 records, all-page filters, CSV encoding/escaping, empty and concurrent-change checks passed.');
})().catch(e=>{console.error(e);process.exitCode=1});
