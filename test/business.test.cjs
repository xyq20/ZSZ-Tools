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
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'toolkit-test-'));const f=path.join(dir,'中文价格.xlsx');const w=new ExcelJS.Workbook(),s=w.addWorksheet('价格表');s.addRow(['货号','商品名称','价格','链接']);s.addRow(['7060--1','商品','','']);s.addRow(['x','公式',{formula:'1+1',result:2},'']);s.addRow(['y','已有',3,'']);s.addRow(['zero','零值',0,'']);s.addRow(['text','文字','待定','']);s.addRow(['empty-formula','空公式',{formula:'IF(1=1,"",1)',result:''},'']);s.getCell('C2').numFmt='0.00';await w.xlsx.writeFile(f);
 const originalBytes=await fs.readFile(f);const before=await JSZip.loadAsync(originalBytes);const b=await readBook(f);const r=match(b,[item('7060-1',12.5),item('x',10,2),item('y',4,3)]);
 for(const ref of ['C3','C4','C5','C6','C7'])await assert.rejects(writePrices(b,r.map(row=>row.ref===ref?{...row,status:'待填入',price:'20'}:row)),/只允许回填/);
 await assert.rejects(writePrices(b,r.map(row=>row.ref==='C2'?{...row,price:'0'}:row)),/只允许回填/);
 assert.deepEqual(await fs.readFile(f),originalBytes);
 const saved=await writePrices(b,r);assert.equal(saved.count,1);
 const after=await JSZip.loadAsync(await fs.readFile(f));for(const key of Object.keys(before.files).filter(k=>!before.files[k].dir&&k!==b.path))assert.deepEqual(await after.file(key).async('nodebuffer'),await before.file(key).async('nodebuffer'),key);
 const read=await readBook(f);assert.equal(read.rows[0].price,'12.5');assert.equal(read.rows[1].formula,true);assert.equal(read.rows[1].price,'2');assert.equal(read.rows[2].price,'3');assert.equal(read.rows[3].price,'0');assert.equal(read.rows[4].price,'待定');assert.equal(read.rows[5].formula,true);assert.equal(read.rows[5].price,'');assert.deepEqual(await fs.readFile(saved.backup),originalBytes);
 await assert.rejects(writePrices(b,r),/已修改/);
});
test('only blank price rows are queried; shared codes and aliases preserve existing values',async()=>{
 const rows=[{code:'existing',price:'10'},{code:'zero',price:'0'},{code:'text',price:'待定'},{code:'negative',price:'-1'},{code:'formula',price:'',formula:true},{code:'shared',price:'8'},{code:'shared',price:''},{code:'7060--1',price:'  '}];
 const calls=[],progress=[];
 const result=await queryPrices({rows},async(route,body)=>{
  calls.push({route,body});
  if(body){assert.deepEqual(new Set(body.outerIds),new Set(['shared','7060--1','7060-1']));return {data:{total:2,records:[{outerId:'shared',baseItemId:1},{outerId:'7060-1',baseItemId:2}]}};}
  const id=Number(new URL('https://local.test'+route).searchParams.get('baseItemId'));
  return {data:item(id===1?'shared':'7060-1',id===1?'12.50':'18',id).detail};
 },message=>progress.push(message));
 assert.equal(calls.length,3);assert.deepEqual(result.map(r=>r.status),['已有价格','已有价格','已有价格','已有价格','公式保留','已有价格','待填入','待填入']);
 assert.equal(result[5].original,'8');assert.equal(result[5].price,'');assert.equal(result[6].price,'12.5');assert.equal(result[7].price,'18');assert.match(progress[0],/待补价格 2 行.*跳过.*6 行/);
});
test('a workbook with no blank price cells makes no requests',async()=>{
 const rows=[{code:'number',price:'1'},{code:'zero',price:'0'},{code:'text',price:'待定'},{code:'formula',price:'',formula:true}];
 const result=await queryPrices({rows},async()=>{assert.fail('filled or formula cells must not trigger requests');},()=>{});
 assert.deepEqual(result.map(r=>r.status),['已有价格','已有价格','已有价格','公式保留']);
});
test('catalog pagination incomplete is rejected',async()=>{await assert.rejects(queryPrices({rows:[{code:'a'}]},async()=>({data:{total:1,records:[]}}),()=>{}),/分页不完整/);});
test('month boundaries use China time and support year rollover',()=>{const m=months('2025-12','2026-01');assert.equal(m.length,2);assert.equal(new Date(m[0].startTime).toISOString(),'2025-11-30T16:00:00.000Z');assert.equal(new Date(m[0].endTime).toISOString(),'2025-12-31T15:59:59.000Z');assert.throws(()=>months('2026-02','2026-01'));});
test('report validates totals and confirms missing stores before export',async()=>{
 const cfg=require('../modules/report/report-config.json');let zeroChecks=0;const row={user_id:String(cfg.shops[0].id),order_pay_amount:'10.01',snapshot_refund_money:'2.00'};const refundRows=cfg.shops.map((shop,index)=>({work_order_id:`w-${index}`,user_id:String(shop.id),trade_pay_time:'2026-01-15 12:00:00',snapshot_refund_money:'2.00'}));
 const request=async(url,b)=>{if(url.endsWith('/sale/finance/page'))return {suc:true,result:1,data:{list:[row],page:{hasNext:false}}};if(url.endsWith('/sale/finance/summary')){if(b.userIdList.includes(','))return {suc:true,result:1,data:{total:1,amount:{order_pay_amount:'10.01'}}};zeroChecks++;return {suc:true,result:1,data:{total:'0'}};}if(url.endsWith('/aftersale/summary')){assert.equal(b.workOrderTimeQueryType,'after_sale_platform_finish');assert.equal(b.pageId,'100745');return {suc:true,result:1,data:{total:'14',amount:{snapshot_refund_money:'28.00'}}};}if(url.endsWith('/aftersale/page'))return {suc:true,result:1,data:{list:refundRows,page:{hasNext:false}}};throw Error(`unexpected URL: ${url}`);};
 const result=await queryReport('2026-01','2026-01',request,()=>{},{intervalMs:0,endpointIntervalMs:0,refundEndTime:1769875199000});assert.equal(zeroChecks,13);assert.equal(result.rows.length,14);assert.equal(result.monthly[0].order_pay_amount,'10.01');assert.deepEqual(result.totals,{order_pay_amount:'10.01',snapshot_refund_money:'28.00'});const f=path.join(await fs.mkdtemp(path.join(os.tmpdir(),'report-test-')),'报告.xlsx');await exportReport(result,f);assert((await fs.stat(f)).size>1000);
 const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(f);assert.equal(wb.worksheets[0].getCell('C6').value.result,10.01);for(const sheet of wb.worksheets){assert.equal(sheet.pageSetup.horizontalCentered,true);sheet.eachRow(row=>row.eachCell(cell=>{assert.equal(cell.alignment.horizontal,'center');assert.equal(cell.alignment.vertical,'middle');}));}
 const invalidFile=path.join(await fs.mkdtemp(path.join(os.tmpdir(),'report-invalid-')),'报告.xlsx');await assert.rejects(exportReport({...result,rows:result.rows.slice(1)},invalidFile),/店铺明细数量/);
 await assert.rejects(queryReport('2026-01','2026-01',async(url,b)=>{const r=await request(url,b);if(url.endsWith('/sale/finance/summary')&&b.userIdList.includes(','))r.data.amount.order_pay_amount='11';return r;},()=>{},{intervalMs:0,endpointIntervalMs:0}),/不一致/);
});
test('report totals retain exact cents across months',()=>{
 assert.deepEqual(reportTotals([{order_pay_amount:'0.10',snapshot_refund_money:'0.01'},{order_pay_amount:'0.20',snapshot_refund_money:'0.02'},{order_pay_amount:'12345678.99',snapshot_refund_money:'5.10'}]),{order_pay_amount:'12345679.29',snapshot_refund_money:'5.13'});
 assert.throws(()=>reportTotals([{order_pay_amount:null,snapshot_refund_money:'0'}]),/金额缺失/);
});
test('report rejects an API response whose result flag is unsuccessful',async()=>{
 const request=async()=>({suc:true,result:0,message:'接口失败'});
 await assert.rejects(queryReport('2026-01','2026-01',request,()=>{},{intervalMs:0,endpointIntervalMs:0}),/接口失败/);
});
test('refund detail rejects unknown shops and invalid pages and reports missing payment times',async()=>{
 const cfg=require('../modules/report/report-config.json');
 const financeRows=cfg.shops.map(shop=>({user_id:String(shop.id),order_pay_amount:'0.00'}));
 const makeRequest=(refundRows,page)=>async(url,b)=>{
  if(url.endsWith('/aftersale/summary'))return {suc:true,result:1,data:{total:String(refundRows.length),amount:{snapshot_refund_money:refundRows.reduce((sum,row)=>sum+Number(row.snapshot_refund_money),0).toFixed(2)}}};
  if(url.endsWith('/aftersale/page'))return {suc:true,result:1,data:{list:refundRows,page}};
  if(url.endsWith('/sale/finance/page'))return {suc:true,result:1,data:{list:financeRows,page:{hasNext:false}}};
  if(url.endsWith('/sale/finance/summary'))return {suc:true,result:1,data:{total:'14',amount:{order_pay_amount:'0.00'}}};
  throw Error(`unexpected URL: ${url}`);
 };
 const options={intervalMs:0,endpointIntervalMs:0,refundEndTime:1769875199000};
 await assert.rejects(queryReport('2026-01','2026-01',makeRequest([{work_order_id:'unknown',user_id:'999',trade_pay_time:'2026-01-15 00:00:00',snapshot_refund_money:'1.00'}],{hasNext:false}),()=>{},options),/未知店铺/);
 const missing=await queryReport('2026-01','2026-01',makeRequest([{work_order_id:'missing-time',user_id:String(cfg.shops[0].id),trade_pay_time:'',snapshot_refund_money:'1.00'}],{hasNext:false}),()=>{},options);
 assert.equal(missing.unassignedRefundAmount,'1.00');
 assert.equal(missing.unassignedRefunds[0].workOrderId,'missing-time');
 await assert.rejects(queryReport('2026-01','2026-01',makeRequest([],{}),()=>{},options),/分页格式无效/);
});

test('payment dates reject impossible dates and retain cross-month refunds across pages', async () => {
  const cfg = require('../modules/report/report-config.json');
  const shopId = String(cfg.shops[0].id);
  const options = { intervalMs: 0, endpointIntervalMs: 0 };
  const makeRequest = paymentTime => async (url, body) => {
    if (url.endsWith('/aftersale/summary')) return { suc: true, result: 1, data: { total: 2, amount: { snapshot_refund_money: '3.00' } } };
    if (url.endsWith('/aftersale/page')) {
      assert.equal(body.pageSize, 500);
      const first = body.pageNo === 1;
      return { suc: true, result: 1, data: {
        list: [{ work_order_id: String(body.pageNo), user_id: shopId,
          trade_pay_time: first ? paymentTime : '2025-12-31 23:59:59',
          work_end_time: '2026-03-01 00:00:00', snapshot_refund_money: first ? '1.00' : '2.00' }],
        page: { hasNext: first },
      } };
    }
    if (url.endsWith('/sale/finance/page')) return { suc: true, result: 1, data: {
      list: cfg.shops.map(shop => ({ user_id: String(shop.id), order_pay_amount: '0.00' })), page: { hasNext: false },
    } };
    return { suc: true, result: 1, data: { total: 14, amount: { order_pay_amount: '0.00' } } };
  };
  for (const value of ['2026-13-01 00:00:00', '2026-02-30 00:00:00', '2026-01-15 25:00:00', '2026-01-invalid']) {
    const unresolved = await queryReport('2026-01', '2026-01', makeRequest(value), () => {}, options);
    assert.equal(unresolved.unassignedRefundAmount, '1.00');
    assert.equal(unresolved.totals.snapshot_refund_money, '0.00');
    const pendingFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'pending-refund-')), 'pending.xlsx');
    await exportReport(unresolved, pendingFile);
    const saved = new ExcelJS.Workbook();
    await saved.xlsx.readFile(pendingFile);
    assert.equal(saved.getWorksheet('待核对退款').getCell('D2').value, 1);
    assert.match(saved.getWorksheet('月度汇总').getCell('A10').value, /待核对/);
  }
  const result = await queryReport('2026-01', '2026-01', makeRequest('2026-01-15 00:00:00'), () => {}, options);
  assert.equal(result.totals.snapshot_refund_money, '1.00');
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'report-amount-')), 'report.xlsx');
  const badRows = result.rows.map((row, index) => index === 0 ? { ...row, snapshot_refund_money: '9.00' } : row);
  await assert.rejects(exportReport({ ...result, rows: badRows }, file), /明细金额与月度汇总不一致/);
  await assert.rejects(fs.access(file));
  await exportReport(result, file);
});
