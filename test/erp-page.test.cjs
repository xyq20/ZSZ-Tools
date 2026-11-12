const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {erpOrigin,validatePayload,requestInErpPage}=require('../business/erp-page.cjs');
const {restoreWindow,bindLoginWindow}=require('../business/windows.cjs');
test('ERP response reports actual server errors instead of inventing permission errors',()=>{
 assert.throws(()=>validatePayload({success:false,errorMsg:'请求异常，请稍后重试访问.'},true),/请求异常/);
 assert.throws(()=>validatePayload({result:901}),/登录已过期/);
 assert.throws(()=>validatePayload({success:false}),/接口未返回成功状态/);
 assert.equal(validatePayload({suc:true},true).suc,true);
 for(const url of ['https://erpb.superboss.cc/index.html','https://viperp.superboss.cc'])assert(erpOrigin(url));
 for(const url of ['https://erpb.superboss.cc.evil.test','http://erpb.superboss.cc','https://login.superboss.cc'])assert.equal(erpOrigin(url),null);
});
test('monthly request uses authenticated page fetch on the redirected ERP shard',async()=>{
 let called=false;const payload={result:1,data:{list:[{itemOuterId:'test'}]}};
 const win={isDestroyed:()=>false,webContents:{isLoading:()=>false,getURL:()=> 'https://erpb.superboss.cc/index.html',executeJavaScript:expression=>vm.runInNewContext(expression,{location:{origin:'https://erpb.superboss.cc'},AbortSignal,fetch:async(url,options)=>{called=true;assert.equal(url,'/report/sale/dimensions/list');assert.equal(options.credentials,'include');assert.equal(options.headers.Companyid,'111873');assert.equal(new URLSearchParams(options.body).get('asTypes'),'1,2,7,8,10');return {ok:true,status:200,headers:{get:()=>null},json:async()=>payload};}})}};
 assert.equal(await requestInErpPage(win,'/report/sale/dimensions/list',{asTypes:'1,2,7,8,10'}),payload);assert(called);
 await assert.rejects(requestInErpPage(win,'/other',{}),/不支持/);
});
test('minimized login returns to main and an existing minimized window can be reopened',()=>{
 const calls=[],main={isDestroyed:()=>false,isMinimized:()=>true,restore:()=>calls.push('restore'),show:()=>calls.push('show'),focus:()=>calls.push('focus')};
 const login=new EventEmitter();bindLoginWindow(login,main);login.emit('minimize');assert.deepEqual(calls,['restore','show','focus']);
 calls.length=0;restoreWindow(main);assert.deepEqual(calls,['restore','show','focus']);
 restoreWindow({isDestroyed:()=>true});
});

test('report query reaches after-sale and finance endpoints through the desktop bridge', async () => {
 const {queryReport}=require('../business/reports.cjs');
 const config=require('../modules/report/report-config.json');
 const calls=[];
 const win={isDestroyed:()=>false,webContents:{isLoading:()=>false,getURL:()=> 'https://erpa.superboss.cc/index.html',executeJavaScript:expression=>vm.runInNewContext(expression,{
  location:{origin:'https://erpa.superboss.cc'},AbortSignal,
  fetch:async(route,options)=>{
   calls.push(route);
   const body=JSON.parse(options.body);
   assert.equal(options.credentials,'include');
   let data;
   if(route.includes('/aftersale/')) {
    assert.equal(options.headers.CompanyId,'111873');
    assert.equal(options.headers['Module-Path'],'/report/dynamic/?reportId=67953');
    assert.equal(body.pageId,'100745');
    assert.equal(body.workOrderTimeQueryType,'after_sale_platform_finish');
    assert.equal(body.userIdList,config.shops.map(shop=>shop.id).join(','));
    data=route.endsWith('/summary')?{total:1,amount:{snapshot_refund_money:'2.00'}}:{list:[{work_order_id:'test',user_id:String(config.shops[0].id),trade_pay_time:'2026-01-10 12:00:00',snapshot_refund_money:'2.00'}],page:{hasNext:false}};
   } else {
    data=route.endsWith('/summary')?{total:14,amount:{order_pay_amount:'14.00'}}:{list:config.shops.map(shop=>({user_id:String(shop.id),order_pay_amount:'1.00'})),page:{hasNext:false}};
   }
   return {ok:true,status:200,headers:{get:()=>null},json:async()=>({suc:true,result:1,data})};
  }
 })}};
 const result=await queryReport('2026-01','2026-01',(route,body)=>requestInErpPage(win,route,body),()=>{},{intervalMs:0,endpointIntervalMs:0});
 assert.equal(result.totals.snapshot_refund_money,'2.00');
 assert.equal(calls.length,4);
 for(const route of ['/kmrp/statistics/history/aftersale/delete','/kmrp/statistics/history/aftersale/page?x=1','https://elsewhere.test/kmrp/statistics/history/aftersale/page']) {
  await assert.rejects(requestInErpPage(win,route,{}),/不支持/);
 }
});
