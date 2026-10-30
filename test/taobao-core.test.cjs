const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {scanFolder,productQuery}=require((require('node:fs').existsSync(require('node:path').join(__dirname,'../scripts/validate-choices.js'))?'../scripts/':'../modules/taobao/scripts/')+'catalog');
const {generateChoices,validTopic}=require((require('node:fs').existsSync(require('node:path').join(__dirname,'../scripts/validate-choices.js'))?'../scripts/':'../modules/taobao/scripts/')+'model');
const {assertRunnable,readState,writeState}=require((require('node:fs').existsSync(require('node:path').join(__dirname,'../scripts/validate-choices.js'))?'../scripts/':'../modules/taobao/scripts/')+'state');
test('folder scan is read only, handles unnumbered names and excludes marked files',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tb-scan-'));
 try{
  await fs.writeFile(path.join(dir,'红海.mp4'),'one');await fs.writeFile(path.join(dir,'红海 2.mp4'),'two');await fs.writeFile(path.join(dir,'已传 3.mp4'),'three');
  const r=await scanFolder(dir);assert.equal(r.rows.length,2);assert.equal(r.skipped,1);assert.equal(productQuery('红海.mp4'),'红海');assert.equal(productQuery('红海 2.mp4'),'红海');
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
