const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const ExcelJS=require('exceljs');const JSZip=require('jszip');
const {readBook,writePrices,match,choose,queryPrices}=require('../business/prices.cjs');const {months,queryReport,exportReport,reportTotals}=require('../business/reports.cjs');
const item=(code,p,id=1)=>({outerId:code,baseItemId:id,detail:{id,baseItemId:id,skuFix:true,skuList:[{skuPrice:p,baseItemId:id}]}});
test('exact aliases, duplicate codes, formulas and SKU validation',()=>{
 const rows=[{code:'7060--1',price:'',formula:false},{code:'x',price:'10',formula:true},{code:'missing',price:'',formula:false}];
 const r=match({rows},[item('7060-1','12.50'),item('X','10',2)]);assert.equal(r[0].price,'12.5');assert.equal(r[0].status,'待填入');assert.equal(r[1].status,'公式保留');assert.equal(r[2].status,'待核对');
 assert.equal(match({rows:[rows[0]]},[item('7060-1',10),item('7060-1',10,2)])[0].status,'待核对');
 const d=item('x',10);d.detail.skuList.push({skuPrice:11});assert.equal(choose(d).price,undefined);d.detail.skuList=[{skuPrice:0}];assert.equal(choose(d).price,undefined);
});
test('xlsx targeted patch preserves unrelated zip entries and formulas; rejects stale file',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'toolkit-test-'));const f=path.join(dir,'中文价格.xlsx');const w=new ExcelJS.Workbook(),s=w.addWorksheet('价格表');s.addRow(['货号','商品名称','价格','链接']);s.addRow(['7060--1','商品','','']);s.addRow(['x','公式',{formula:'1+1',result:2},'']);s.addRow(['y','已有',3,'']);s.getCell('C2').numFmt='0.00';await w.xlsx.writeFile(f);
 const originalBytes=await fs.readFile(f);const before=await JSZip.loadAsync(originalBytes);const b=await readBook(f);const r=match(b,[item('7060-1',12.5),item('x',10,2),item('y',4,3)]);const saved=await writePrices(b,r);assert.equal(saved.count,2);
 const after=await JSZip.loadAsync(await fs.readFile(f));for(const key of Object.keys(before.files).filter(k=>!before.files[k].dir&&k!==b.path))assert.deepEqual(await after.file(key).async('nodebuffer'),await before.file(key).async('nodebuffer'),key);
 const read=await readBook(f);assert.equal(read.rows[0].price,'12.5');assert.equal(read.rows[1].formula,true);assert.equal(read.rows[1].price,'2');assert.equal(read.rows[2].price,'4');assert.deepEqual(await fs.readFile(saved.backup),originalBytes);
 await assert.rejects(writePrices(b,r),/已修改/);
});
test('catalog pagination incomplete is rejected',async()=>{await assert.rejects(queryPrices({rows:[{code:'a'}]},async()=>({data:{total:1,records:[]}}),()=>{}),/分页不完整/);});
test('month boundaries use China time and support year rollover',()=>{const m=months('2025-12','2026-01');assert.equal(m.length,2);assert.equal(new Date(m[0].startTime).toISOString(),'2025-11-30T16:00:00.000Z');assert.equal(new Date(m[0].endTime).toISOString(),'2025-12-31T15:59:59.000Z');assert.throws(()=>months('2026-02','2026-01'));});
test('report validates totals and confirms missing stores before export',async()=>{
 const cfg=require('../business/report-config.json');let zeroChecks=0;const row={user_id:String(cfg.shops[0].id),order_pay_amount:'10.01',snapshot_refund_money:'2.00'};
 const request=async(url,b)=>{if(url.endsWith('sniff'))return {suc:true,data:{}};if(url.endsWith('page'))return {suc:true,data:{list:[row],page:{hasNext:false}}};if(b.userIdList.includes(','))return {suc:true,data:{total:1,amount:{order_pay_amount:'10.01',snapshot_refund_money:'2'}}};zeroChecks++;return {suc:true,data:{total:'0'}};};
 const result=await queryReport('2026-01','2026-01',request,()=>{});assert.equal(zeroChecks,13);assert.equal(result.rows.length,14);assert.equal(result.monthly[0].order_pay_amount,'10.01');assert.deepEqual(result.totals,{order_pay_amount:'10.01',snapshot_refund_money:'2.00'});const f=path.join(await fs.mkdtemp(path.join(os.tmpdir(),'report-test-')),'报告.xlsx');await exportReport(result,f);assert((await fs.stat(f)).size>1000);
 const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(f);assert.equal(wb.worksheets[0].getCell('C6').value.result,10.01);for(const sheet of wb.worksheets){assert.equal(sheet.pageSetup.horizontalCentered,true);sheet.eachRow(row=>row.eachCell(cell=>{assert.equal(cell.alignment.horizontal,'center');assert.equal(cell.alignment.vertical,'middle');}));}
 await assert.rejects(queryReport('2026-01','2026-01',async(url,b)=>{const r=await request(url,b);if(url.endsWith('summary')&&b.userIdList.includes(','))r.data.amount.order_pay_amount='11';return r;},()=>{}),/不一致/);
});
test('report totals retain exact cents across months',()=>{
 assert.deepEqual(reportTotals([{order_pay_amount:'0.10',snapshot_refund_money:'0.01'},{order_pay_amount:'0.20',snapshot_refund_money:'0.02'},{order_pay_amount:'12345678.99',snapshot_refund_money:'5.10'}]),{order_pay_amount:'12345679.29',snapshot_refund_money:'5.13'});
 assert.throws(()=>reportTotals([{order_pay_amount:null,snapshot_refund_money:'0'}]),/金额缺失/);
});
