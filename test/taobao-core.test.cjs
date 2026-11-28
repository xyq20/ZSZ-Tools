const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {scanFolder,productQuery,productNameFromFile,matchProducts}=require((require('node:fs').existsSync(require('node:path').join(__dirname,'../scripts/validate-choices.js'))?'../scripts/':'../modules/taobao/scripts/')+'catalog');
const {generateChoices,validTopic}=require((require('node:fs').existsSync(require('node:path').join(__dirname,'../scripts/validate-choices.js'))?'../scripts/':'../modules/taobao/scripts/')+'model');
const {assertRunnable,readState,writeState}=require((require('node:fs').existsSync(require('node:path').join(__dirname,'../scripts/validate-choices.js'))?'../scripts/':'../modules/taobao/scripts/')+'state');
const {searchProductResults}=require((require('node:fs').existsSync(require('node:path').join(__dirname,'../scripts/validate-choices.js'))?'../scripts/':'../modules/taobao/scripts/')+'platform');
const {EventEmitter}=require('node:events');

function productSearchFixture(){
 const page=new EventEmitter(),frame={page:()=>page};
 page.waitForResponse=predicate=>new Promise(resolve=>{
  const receive=response=>{if(predicate(response)){page.off('response',receive);resolve(response);}};
  page.on('response',receive);
 });
 const request=(keyword,owner=frame)=>({
  method:()=>'POST',url:()=>'https://example.test/mtop.taobao.media.guang.item.listitems/',
  frame:()=>owner,postDataJSON:()=>({data:JSON.stringify({keyword,cursor:''})}),
 });
 function respond(req,items,code='SUCCESS::OK'){
  page.emit('response',{request:()=>req,ok:()=>true,json:async()=>({ret:[code],data:{data:items}})});
 }
 return {page,frame,request,respond};
}
test('product lookup ignores recommendation responses, older searches, and another frame', {timeout:2000},async()=>{
 const {page,frame,request,respond}=productSearchFixture();
 const stale=request('大卡车'),recommendations=request(''),otherFrame=request('大卡车',{});
 page.emit('request',stale);
 const result=await searchProductResults(frame,'大卡车',async()=>{
  page.emit('request',recommendations);
  page.emit('request',otherFrame);
  const current=request('大卡车');
  page.emit('request',current);
  for(const req of [stale,recommendations,otherFrame])respond(req,[{itemId:'111',title:'【加勒比】工装牛仔裤'}]);
  respond(current,[{itemId:'222',title:'【大卡车】工装'}]);
 });
 assert.deepEqual(result,[{id:'222',title:'【大卡车】工装'}]);
 assert.equal(page.listenerCount('request'),0);
});
test('product lookup distinguishes a confirmed empty result from a platform error', {timeout:2000},async()=>{
 const {page,frame,request,respond}=productSearchFixture();
 const search=code=>searchProductResults(frame,'战术裤 升级版',async()=>{
  const req=request('战术裤 升级版');
  page.emit('request',req);
  respond(req,[],code);
 });
 assert.deepEqual(await search('SUCCESS::OK'),[]);
 await assert.rejects(search('FAIL_SYS_SESSION_EXPIRED'),/未确认本次千牛商品搜索结果/);
});
test('an upgraded product matches separator variations but excludes the original and other versions',()=>{
 const products=[
  {id:'1',title:'【战术裤•升级版】休闲工装裤'},
  {id:'2',title:'【战术裤·升级版】多口袋工装裤'},
  {id:'3',title:'【战术裤】原版'},
  {id:'4',title:'【战术裤•加厚版】工装裤'},
 ];
 assert.deepEqual(matchProducts(products,productQuery('战术裤 升级版 1.mp4')).map(x=>x.id),['1','2']);
 assert.deepEqual(matchProducts([{id:'5',title:'【劳动节40】皮带'}],'劳动节4.0皮带'),[]);
});

test('folder scan is read only, handles unnumbered names and excludes marked files',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tb-scan-'));
 try{
  await fs.writeFile(path.join(dir,'红海.mp4'),'one');await fs.writeFile(path.join(dir,'红海 2.mp4'),'two');await fs.writeFile(path.join(dir,'已传 3.mp4'),'three');
  const r=await scanFolder(dir);assert.equal(r.rows.length,2);assert.equal(r.skipped,1);assert.equal(productQuery('红海.mp4'),'红海');assert.equal(productQuery('红海 2.mp4'),'红海');
  assert.equal(productQuery('xxxx1.mp4'),'xxxx');
  assert.equal(productQuery('xx1xx.mp4'),'xx1xx');
  assert.equal(productQuery('xx1xx 12.MP4'),'xx1xx');
  assert.equal(productQuery('xx1xx-12.mp4'),'xx1xx');
  assert.equal(productQuery('xx1xx_12.mp4'),'xx1xx');
  assert.equal(productNameFromFile('xx1xx.mp4'),'xx1xx');
  assertRunnable(r.rows);assert.throws(()=>assertRunnable([{...r.rows[0],status:'unknown'}]));
  await fs.writeFile(path.join(dir,'重复.mp4'),'one');await assert.rejects(scanFolder(dir),/相同/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('model output must use actual product and currently eligible topic',async()=>{
 const args={items:[{file:'红海.mp4',product_id:'123',product_name:'【红海】开衫'}],topics:[{id:'456',title:'穿搭'}],date:'2026-10-30',key:'test'};
 const choice={file:'红海.mp4',product_id:'123',caption:'换季开衫搭起来',topic_id:'456',topic_title:'穿搭'};
 const fetchImpl=async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify([choice])}}]})});
 assert.equal((await generateChoices({...args,fetchImpl}))[0].product_name,'【红海】开衫');
 choice.product_id='789';await assert.rejects(generateChoices({...args,fetchImpl}),/候选以外/);
 assert(!validTopic({activities:[{begin:'2026-09-01 00:00:00',end:'2026-09-30 23:59:59'}]},'2026-10-30'));
});
test('publication journal survives restart and refuses corrupt state',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tb-state-')),file=path.join(dir,'state.json');
 try{assert.deepEqual(await readState(file),{records:{},captions:[]});await writeState(file,{records:{a:{status:'submitted',file:'a.mp4',at:'2026-10-30T00:00:00Z'}},captions:[]});assert.equal((await readState(file)).records.a.status,'submitted');await fs.writeFile(file,'{}');await assert.rejects(readState(file),/损坏/);await fs.writeFile(file,'broken');await assert.rejects(readState(file),/损坏/);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
const {verifyPublication}=require((require('node:fs').existsSync(require('node:path').join(__dirname,'../scripts/validate-choices.js'))?'../scripts/':'../modules/taobao/scripts/')+'publication-result');
test('a click, toast or different batch is never treated as confirmed publication',()=>{
 const choices=[{file:'a.mp4'},{file:'b.mp4'}];
 for(const d of [null,{status:'clicked'},{type:'onBatchPublishSuccess',data:{publishData:{'a.mp4':{}}}},{type:'onBatchPublishSuccess',data:{publishData:{'c.mp4':{},'d.mp4':{}}}}])assert.equal(verifyPublication(d,choices),false);
 assert(verifyPublication({type:'onBatchPublishSuccess',data:{publishData:{'a.mp4':{},'b.mp4':{}}}},choices));
});

const {topicFits}=require((require('node:fs').existsSync(require('node:path').join(__dirname,'../scripts/validate-choices.js'))?'../scripts/':'../modules/taobao/scripts/')+'model');
test('activity minimum video duration is enforced before filling',()=>{
 const topic={activities:[{begin:'2026-09-01 00:00:00',end:'2026-11-30 23:59:59',detail:'基础投稿要求： 视频≥10s'}]};
 assert(!topicFits(topic,{duration:9.9},'2026-10-30'));assert(!topicFits(topic,{},'2026-10-30'));assert(topicFits(topic,{duration:10},'2026-10-30'));
});

test('real filenames preserve versions and strip separated sequence and author notes',()=>{
 const {productSearchQueries,matchProducts}=require((require('node:fs').existsSync(require('node:path').join(__dirname,'../scripts/validate-choices.js'))?'../scripts/':'../modules/taobao/scripts/')+'catalog');
 for(const [file,expected] of [['弹壳 2 亿棠.mp4','弹壳'],['地下拳手夹克 4 亿棠.mp4','地下拳手夹克'],['四驱 1 某某.mp4','四驱'],['劳动节4.0皮带.mp4','劳动节4.0皮带'],['劳动节4.0.mp4','劳动节4.0'],['xx1xx.mp4','xx1xx']])assert.equal(productQuery(file),expected);
 assert.deepEqual(productSearchQueries('地下拳手夹克 5 亿棠.mp4'),['地下拳手夹克','地下拳手']);
 const candidates=[{id:'123',title:'【劳动节4.0】NEIGBORL 牛皮皮带'},{id:'456',title:'【劳动节3.0】NEIGBORL 牛皮皮带'}];
 assert.deepEqual(matchProducts(candidates,'劳动节4.0皮带'),[candidates[0]]);
 assert.deepEqual(matchProducts([candidates[0],candidates[0]],'劳动节4.0皮带'),[candidates[0]]);
 assert.equal(matchProducts([...candidates,{...candidates[0],id:'789'}],'劳动节4.0皮带').length,2);
 assert.deepEqual(matchProducts([{id:'123',title:'【地下拳手】短裤'}],'地下拳手夹克'),[]);
 assert.deepEqual(matchProducts([{id:'123',title:'【地下拳手】皮夹克'}],'地下拳手夹克').map(c=>c.id),['123']);
});

test('all matched products survive model generation and cannot be replaced by model associations',async()=>{
 const products=[{id:'123',title:'【地下拳手】夹克一'},{id:'456',title:'【地下拳手】夹克二'},{id:'789',title:'【地下拳手】夹克三'}];
 const choice={file:'地下拳手 4 亿棠.mp4',caption:'日常夹克穿搭',product_id:'123',topic_id:'9',topic_title:'穿搭',products:[{id:'123',title:'错误标题'}]};
 const result=await generateChoices({items:[{file:choice.file,product_id:'123',product_name:products[0].title,products}],topics:[{id:'9',title:'穿搭'}],date:'2026-11-13',key:'fixture',fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify([choice])}}]})})});
 assert.deepEqual(result[0].products,products);
});
