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
 const win={isDestroyed:()=>false,webContents:{isLoading:()=>false,getURL:()=> 'https://erpb.superboss.cc/index.html',executeJavaScript:expression=>vm.runInNewContext(expression,{location:{origin:'https://erpb.superboss.cc'},AbortSignal,fetch:async(url,options)=>{called=true;assert.equal(url,'/report/sale/dimensions/list');assert.equal(options.credentials,'include');assert.equal(options.headers.Companyid,'111873');assert.equal(new URLSearchParams(options.body).get('asTypes'),'1,2,7,8,10');return {ok:true,status:200,json:async()=>payload};}})}};
 assert.equal(await requestInErpPage(win,'/report/sale/dimensions/list',{asTypes:'1,2,7,8,10'}),payload);assert(called);
 await assert.rejects(requestInErpPage(win,'/other',{}),/不支持/);
});
test('minimized login returns to main and an existing minimized window can be reopened',()=>{
 const calls=[],main={isDestroyed:()=>false,isMinimized:()=>true,restore:()=>calls.push('restore'),show:()=>calls.push('show'),focus:()=>calls.push('focus')};
 const login=new EventEmitter();bindLoginWindow(login,main);login.emit('minimize');assert.deepEqual(calls,['restore','show','focus']);
 calls.length=0;restoreWindow(main);assert.deepEqual(calls,['restore','show','focus']);
 restoreWindow({isDestroyed:()=>true});
});
