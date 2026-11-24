const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {toolOf,createRedactor,createActivity,createDiagnostics,registerReadOnly}=require('../business/diagnostics.cjs');

const JOB='20261119_153000_abcdef12',DONE_JOB='20261118_100000_0badc0de';
const WEBHOOK='https://open.feishu.cn/open-apis/bot/v2/hook/0000-1111-2222-3333';
const WRITES=['writeFile','appendFile','mkdir','mkdtemp','rm','rmdir','rename','unlink','copyFile','cp','utimes','chmod','chown','truncate','symlink','link','lchown','lutimes'];

async function temporary(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'toolkit-diag-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 return root;
}
async function put(root,relative,content=''){
 const file=path.join(root,...relative.split('/'));
 await fs.mkdir(path.dirname(file),{recursive:true});
 await fs.writeFile(file,content);
 return file;
}
async function plant(root,{corrupt=false}={}){
 await put(root,'taobao/model-key.bin','sk-PLANTEDMODELKEY0001');
 await fs.mkdir(path.join(root,'taobao','browser-profile'),{recursive:true});
 await put(root,'taobao/session-cookies.bin','ENCRYPTED-SESSION');
 await put(root,'taobao/history.json',corrupt?'{"records":':JSON.stringify({records:{
  a:{file:'a.mp4',status:'submitted',at:'2026-11-19T01:00:00.000Z'},
  b:{file:'b.mp4',status:'unknown',at:'2026-11-19T02:00:00.000Z'},
  c:{file:'c.mp4',status:'published',at:'2026-11-18T02:00:00.000Z'}},captions:['旧文案']}));
 await put(root,'taobao-soutu/publish-state.json',corrupt?'not json':JSON.stringify({
  k1:{group:'红海/黑色',itemId:'778899',title:'PLANTED商品标题',status:'pending',time:'2026-11-20T01:00:00.000Z'},
  k2:{group:'蓝色',itemId:'112233',title:'另一个标题',status:'published',time:'2026-11-19T01:00:00.000Z'}}));
 await put(root,'taobao-soutu/run.lock','4242\n');
 await fs.mkdir(path.join(root,'taobao-soutu','chrome-profile'),{recursive:true});
 const job={workflow_version:1,job_id:JOB,created_at:'2026-11-19T07:30:00.123456+00:00',source_path:path.join(root,'Desktop','二店库存11月.xlsx'),
  source_filename:'二店库存11月.xlsx',source_validated:true,shop:{id:'SHOP-PLANTED-9988'}};
 await put(root,`taobao-stock/output/jobs/${JOB}/job.json`,JSON.stringify(job));
 await put(root,`taobao-stock/output/jobs/${JOB}/state.json`,JSON.stringify({...job,status:'paused',items:[{name:'PLANTED库存商品'}]}));
 await put(root,`taobao-stock/output/jobs/${DONE_JOB}/job.json`,JSON.stringify({...job,job_id:DONE_JOB}));
 await put(root,`taobao-stock/output/jobs/${DONE_JOB}/state.json`,JSON.stringify({...job,job_id:DONE_JOB,status:'completed'}));
 if(corrupt){
  const big='20261117_090000_11111111',broken='20261116_090000_22222222';
  await put(root,`taobao-stock/output/jobs/${big}/job.json`,JSON.stringify({...job,job_id:big}));
  await put(root,`taobao-stock/output/jobs/${big}/state.json`,'{"pad":"'+'x'.repeat(4*1024*1024+16)+'"}');
  await put(root,`taobao-stock/output/jobs/${broken}/job.json`,JSON.stringify({...job,job_id:broken}));
  await put(root,`taobao-stock/output/jobs/${broken}/state.json`,'{"job_id":');
 }
 await fs.mkdir(path.join(root,'taobao-stock','.browser-profile','er-dian'),{recursive:true});
 await put(root,'taobao-stock/.runtime/shop.json',JSON.stringify({shop_id:'SHOP-PLANTED-9988'}));
 const run=path.join(root,'sycm','runs','run-x');
 await put(root,'sycm/last-task.json',JSON.stringify({directory:run,args:['--mode','all'],options:{mode:'all'}}));
 await put(root,'sycm/runs/run-x/output/sycm/progress.json',JSON.stringify({stage:'incomplete',index:40,total:60,ok:38,fail:2,skipped:0,name:'PLANTED生意参谋商品',error:'PLANTED错误详情'}));
 await put(root,'sycm/auth/chrome_profile/Default/Preferences','{}');
 await put(root,'sycm/auth/login_meta.json',JSON.stringify({saved_at:'2026-11-17T09:00:00+08:00'}));
 await put(root,'return-rate/kuaimai-api.enc','ENCRYPTED-API');
 await fs.mkdir(path.join(root,'monthly-runs','2026-11-15-abc123'),{recursive:true});
 await put(root,'logs/toolkit-errors.log',JSON.stringify({at:'2026-11-20T09:52:00.000Z',action:'return-rate-start',tool:'return-rate',
  message:`appSecret=PLANTEDAPPSECRET123 回调 ${WEBHOOK}`})+'\n'+'not json\n');
 await put(root,'startup.log',`2026-11-12T03:21:00.000Z Error: boom\n    at load (${path.join(root,'Applications','main.cjs')}:12)\n`);
 await put(root,'updates/0.4.39-darwin-arm64/healthy.failed','旧版本的失败记录，已被后续更新取代');
 await put(root,'updates/0.5.1-darwin-arm64/healthy.failed',`新版窗口 60 秒内未确认启动 ${path.join(root,'Library','x.log')}`);
 await put(root,'updates/0.4.39-darwin-arm64/install.log','install ok\n');
 await put(root,'runtime/bin/python3.12','');
 for(const script of ['monthly-python/bridge.py','return-rate-python/bridge.py','sycm-python/run.py','taobao-reminders-python/remind.py','taobao-stock/bridge.py','erp-stock-rules-python/bridge.py'])
  await put(root,'components/'+script,'');
}
function watchFs(){
 const calls=[];
 const proxy=new Proxy(fs,{get(target,name){
  const value=target[name];
  if(typeof value!=='function')return value;
  return (...args)=>{calls.push({name,args});return value.apply(target,args);};
 }});
 return {proxy,calls};
}
function setup(root,options={}){
 let decrypted=false;
 const redact=createRedactor({home:root,platform:process.platform});
 const report={cookies:{get:async()=>[{name:'erp-session',value:'SECRETCOOKIE',domain:'.superboss.cc',path:'/',session:true}]}};
 const watcher=watchFs();
 const diagnostics=createDiagnostics({
  app:{getPath:name=>({userData:root,home:root})[name],getVersion:()=>'0.5.0',isPackaged:false,getLocale:()=>'zh-CN'},
  safeStorage:{isEncryptionAvailable:()=>true,decryptString:()=>{decrypted=true;throw Error('decryptString must not be called');}},
  sessions:{report,monthly:report,price:{cookies:{get:async()=>[]}}},
  loginReady:options.loginReady??Promise.resolve(),
  reminders:{status:()=>({enabled:true,at:'09:05',hasWebhook:true,recipient:'ou_abcdef1234567890',hasLogin:true,nativeAgent:false,
   message:`推送失败 ${WEBHOOK} 密钥 sk-PLANTEDKEY123 联系 13812345678（15 分钟后重试）`})},
  getRunning:options.getRunning??(()=>null),
  activity:createActivity({directory:path.join(root,'logs'),redact,fs:watcher.proxy}),
  redact,fs:options.fs??watcher.proxy,
  proc:{platform:'darwin',arch:'arm64',versions:{node:'22.20.0',electron:'40.1.0',chrome:'144.0.0.0'},uptime:()=>12.4,getSystemVersion:()=>'15.1'},
  runtimePaths:()=>({python:path.join(root,'runtime','bin','python3.12')}),
  browserPath:()=>null,
  componentsRoot:path.join(root,'components'),
  ...options.extra,
 });
 return {diagnostics,watcher,wasDecrypted:()=>decrypted};
}
async function tree(root){
 const result={};
 async function walk(directory){
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){
   const file=path.join(directory,entry.name),info=await fs.lstat(file);
   result[path.relative(root,file)]={dir:entry.isDirectory(),size:entry.isDirectory()?0:info.size,mtimeMs:info.mtimeMs};
   if(entry.isDirectory())await walk(file);
  }
 }
 await walk(root);
 return result;
}

test('toolOf maps every kind of action to its tool',()=>{
 const table={'choose':'price','login':'','price-query':'price','price-save':'price','report-query':'report','monthly-preview':'monthly',
  'return-rate-status':'return-rate','taobao-settings':'taobao','taobao-history':'taobao','taobao-reminders-run-now':'taobao-reminders',
  'taobao-reminders-scheduled':'taobao-reminders','taobao-stock-resume':'taobao-stock','taobao-soutu-publish':'taobao-soutu',
  'sycm-start':'sycm','erp-stock-rules-upload':'erp-stock-rules','toolkit-overview':'','unknown':'','taobaox':''};
 for(const [action,tool] of Object.entries(table))assert.equal(toolOf(action),tool,action);
});

test('redactor hides secrets, home paths and phone numbers in contract order',()=>{
 const redact=createRedactor({home:'/Users/zhao',platform:'darwin'});
 const text=redact(`at /Users/zhao/Library/x.log ${WEBHOOK} Authorization: Bearer abc.def-123 Cookie: a=1; b=2\nsk-ABCDEF123 ou_abcdef1234567890 "appSecret":"PLAIN" 13812345678 ${'Ab1'.repeat(14)} ${'a1b2c3'.repeat(8)}`,1000);
 for(const leak of ['/Users/zhao','hook/0000','abc.def-123','a=1','sk-ABCDEF123','ou_abcdef','PLAIN','13812345678','Ab1Ab1Ab1'])assert.ok(!text.includes(leak),leak);
 assert.match(text,/~\/Library\/x\.log/);assert.match(text,/138\*\*\*\*5678/);assert.match(text,/a1b2c3a1b2c3/);
 assert.equal(redact('x'.repeat(500)).length,300);
 assert.equal(redact('/Users/zhaoshu/a'),'~/a'); // any account's home directory is personal data
});

test('redactor also covers quoted cookie keys, token-like keys, Basic credentials, +86 phones, bare webhook paths and short home names',()=>{
 const redact=createRedactor({home:'C:\\Users\\Administrator',platform:'win32'});
 const samples=['{"cookie": "cookie2=abc123; unb=2200"}',"{'Cookie': 'x=1'}",'_tb_token_=e3f1a2b9','client_secret=S3CRETVALUE','sessionid=abcdef12',
  'X-Api-Key: K3Y-VALUE','Authorization: Basic dXNlcjpwYXNz','+8613812345678','/open-apis/bot/v2/hook/0000aaaa-bbbb',
  'https:\\/\\/open.feishu.cn\\/open-apis\\/bot\\/v2\\/hook\\/0000cccc','C:\\Users\\ADMINI~1\\AppData\\x.log','路径 /Users/zhao. 结束'];
 const out=samples.map(sample=>redact(sample,1000));
 for(const leak of ['cookie2=abc123','unb=2200','x=1','e3f1a2b9','S3CRETVALUE','abcdef12','K3Y-VALUE','dXNlcjpwYXNz','13812345678','0000aaaa','0000cccc','ADMINI~1','/Users/zhao'])
  assert.ok(!out.join('\n').includes(leak),leak);
 assert.equal(out[7],'138****5678');assert.equal(out[10],'~\\AppData\\x.log');
 // Ordinary words next to these keywords are left alone.
 assert.equal(redact('Basic settings 已保存'),'Basic settings 已保存');
});

test('redactor hides every Authorization scheme, raw Taobao cookies, storage_state values and escaped paths',()=>{
 const redact=createRedactor({home:'/Users/zhao',platform:'darwin'});
 const samples=['Authorization: basic dXNlcjpwYXNz','authorization: Token abc123def456','Authorization: Digest username="zhao", response="6629fae4"',
  '{"file":"\\/Users\\/zhao\\/Desktop\\/a.xlsx"}','https:\\\\/\\\\/open.feishu.cn\\\\/open-apis\\\\/bot\\\\/v2\\\\/hook\\\\/0000dddd',
  'cookie2=abc123; unb=2200123456; sgcookie=E100xyz','{"name":"cookie2","value":"1a2b3c4d"}','pwd=hunter2','"password": "my secret pass"',
  'C:\\Users\\John Smith\\Desktop\\a.xlsx','/home/zhao/x.log'];
 const out=samples.map(sample=>redact(sample,1000)).join('\n');
 for(const leak of ['dXNlcjpwYXNz','abc123def456','6629fae4','username="zhao"','/Users','zhao','0000dddd','abc123','2200123456','E100xyz','1a2b3c4d','hunter2','secret pass','John','Smith'])
  assert.ok(!out.includes(leak),leak);
});

test('redactor leaves counts, browser flags, shared folders and ordinary text alone',()=>{
 const redact=createRedactor({home:'/Users/zhao',platform:'darwin'});
 for(const text of ['max_tokens: 8192','prompt_tokens=1234, completion_tokens=56','sessions: 2','session_count=3','tokenizer: cl100k','credentials: 已保存',
  'secretary: 小谭','--password-store=basic','https://example.com/home/index','/Users/Shared/共享盘/月报.xlsx','C:\\Users\\Public\\Documents',
  '商品 ID 1072751981649 时间 1763690000000','138\n1234\n5678','basic settings','分级总表已更新'])
  assert.equal(redact(text,1000),text,text);
});

test('redactor runs in linear time on adversarial input',()=>{
 const redact=createRedactor({home:'C:\\Users\\Administrator',platform:'win32'});
 for(const text of ['token-'.repeat(2000),'credential-'.repeat(1100),'secret-'.repeat(1700),'session-'.repeat(1500),'a-'.repeat(20000),
  'x'.repeat(20000),'1'.repeat(20000),'"token":'.repeat(1500),'/Users/'.repeat(2000),'C:\\Users\\'.repeat(1500),('Ab1'.repeat(30)+' token ').repeat(150)]){
  const started=Date.now();redact(text,50000);
  assert.ok(Date.now()-started<250,`${text.slice(0,20)}… took ${Date.now()-started}ms`);
 }
});

test('overview and snapshot report counts without leaking planted secrets or touching files',async t=>{
 const root=await temporary(t);await plant(root);
 const before=await tree(root);
 const {diagnostics,watcher,wasDecrypted}=setup(root);
 const started=Date.now();
 const overview=await diagnostics.overview();
 assert.ok(Date.now()-started<300,'overview should finish within 300ms');
 const snapshot=await diagnostics.snapshot();
 for(const data of [overview,snapshot]){
  const json=JSON.stringify(data);
  for(const leak of ['SECRETCOOKIE','sk-PLANTED','hook/0000','ou_abcdef','13812345678','PLANTEDAPPSECRET123','SHOP-PLANTED','PLANTED生意参谋商品','PLANTED错误详情','PLANTED商品标题','PLANTED库存商品',root])
   assert.ok(!json.includes(leak),'leaked '+leak);
 }
 assert.equal(wasDecrypted(),false);
 const tools=overview.tools;
 assert.equal(overview.schema,1);assert.equal(overview.incomplete,false);assert.equal(overview.running,null);
 assert.deepEqual(overview.env,{encryption:true,python:true,browser:{name:null},components:{ok:true,missing:[]}});
 assert.equal(tools.report.login.evidence,true);assert.equal(tools.monthly.login.evidence,true);assert.equal(tools.price.login.evidence,false);
 assert.deepEqual(tools.monthly.lastPreview?.node,'2026-11-15');
 assert.equal(tools['return-rate'].imported,true);
 assert.equal(tools.taobao.login.evidence,true);assert.equal(tools.taobao.hasKey,true);assert.equal(tools.taobao.recordsError,false);
 assert.equal(tools.taobao.recordsUnchecked,false);
 assert.equal(tools.taobao.records.unknown+tools.taobao.records.submitted,2);assert.equal(tools.taobao.records.published,1);
 const reminder=tools['taobao-reminders'];
 assert.equal(reminder.hasRecipient,true);assert.equal('recipient' in reminder,false);assert.equal(reminder.lastFailed,true);assert.equal(reminder.configUnreadable,false);
 assert.ok(reminder.lastMessage.length<=160);assert.match(reminder.lastMessage,/飞书Webhook已隐藏/);
 const stock=tools['taobao-stock'];
 assert.equal(stock.login.evidence,true);assert.equal(stock.bound,true);
 assert.deepEqual({...stock.jobs,latest:undefined},{checked:2,resumable:1,needsReview:0,unchecked:0,latest:undefined});
 assert.equal(stock.jobs.latest.file,'二店库存11月.xlsx');assert.equal(stock.jobs.latest.status,'paused');
 assert.equal(stock.jobs.latest.createdAt,'2026-11-19T07:30:00.123Z');
 assert.equal(tools.sycm.login.evidence,true);
 assert.deepEqual({...tools.sycm.lastTask,at:undefined},{stage:'incomplete',index:40,total:60,ok:38,fail:2,skipped:0,incomplete:true,at:undefined});
 const soutu=tools['taobao-soutu'];
 assert.deepEqual(soutu.records,{published:1,pending:1});assert.equal(soutu.pendingGroup,'红海/黑色');assert.equal(soutu.recordsError,false);
 assert.equal(soutu.recordsUnchecked,false);
 assert.ok(soutu.staleLock&&typeof soutu.staleLock.at==='string');assert.equal(soutu.hasKey,true);
 assert.equal(snapshot.app.version,'0.5.0');assert.equal(snapshot.app.os,'15.1');
 assert.deepEqual(snapshot.runtime.python,{ok:true,version:'3.12'});assert.equal(snapshot.runtime.components.length,6);
 assert.equal(snapshot.update.failures.length,1);assert.equal(snapshot.update.failures[0].version,'0.5.1'); // 0.4.39 is older than the running 0.5.0
 assert.match(snapshot.update.failures[0].reason,/~/);
 assert.equal(snapshot.logins.length,9);
 const states=Object.fromEntries(snapshot.logins.map(l=>[l.id,l.state]));
 assert.deepEqual(states,{'kuaimai-erp':'present','kuaimai-scm':'missing','kuaimai-api':'configured',taobao:'present',deepseek:'configured',
  'qianniu-reminders':'present','taobao-stock':'present',sycm:'present','qianniu-soutu':'present'});
 assert.equal(snapshot.logins.find(l=>l.id==='qianniu-reminders').note,'Webhook 已配置 · @小谭 已配置 · 每天 09:05');
 assert.equal(snapshot.logins.find(l=>l.id==='taobao-stock').note,'已绑定店铺');
 assert.equal(snapshot.errors.length,1);assert.match(snapshot.errors[0].message,/appSecret=\[已隐藏\]/);
 assert.ok(snapshot.logs.startup.includes(path.join('~','Applications','main.cjs')));assert.equal(snapshot.logs.install,'install ok\n');
 assert.deepEqual(snapshot.paths,{userData:'~',logs:path.join('~','logs'),updates:path.join('~','updates')});
 assert.deepEqual(await tree(root),before,'file tree must stay unchanged');
 assert.deepEqual(watcher.calls.filter(c=>WRITES.includes(c.name)).map(c=>c.name),[]);
 assert.ok(watcher.calls.filter(c=>c.name==='open').every(c=>c.args[1]==='r'));
 assert.ok(!watcher.calls.some(c=>/\.bin$|session-cookies|Cookies/.test(String(c.args[0]))&&c.name==='open'),'never opens .bin or cookie files');
});

test('staleLock depends on whether the soutu task itself is running',async t=>{
 const root=await temporary(t);await plant(root);
 assert.notEqual((await setup(root).diagnostics.overview()).tools['taobao-soutu'].staleLock,null);
 const running=await setup(root,{getRunning:()=>({action:'taobao-soutu-publish',tool:'taobao-soutu',since:1})}).diagnostics.overview();
 assert.equal(running.tools['taobao-soutu'].staleLock,null);
 assert.deepEqual(running.running,{action:'taobao-soutu-publish',tool:'taobao-soutu',since:1});
});

test('corrupt JSON and oversized state files never throw',async t=>{
 const root=await temporary(t);await plant(root,{corrupt:true});
 const {diagnostics}=setup(root);
 const overview=await diagnostics.overview(),snapshot=await diagnostics.snapshot();
 assert.equal(overview.tools.taobao.recordsError,true);assert.equal(overview.tools.taobao.records,null);
 assert.equal(overview.tools['taobao-soutu'].recordsError,true);assert.equal(overview.tools['taobao-soutu'].records,null);
 assert.equal(overview.tools.taobao.recordsUnchecked,false);assert.equal(overview.tools['taobao-soutu'].recordsUnchecked,false);
 const jobs=overview.tools['taobao-stock'].jobs;
 assert.equal(jobs.checked,4);assert.equal(jobs.unchecked,1);assert.equal(jobs.needsReview,1);assert.equal(jobs.resumable,1);
 assert.equal(snapshot.logins.length,9);
});

// Same layout as the business writers: modules/taobao/scripts/state.js and modules/taobao-soutu/state.mjs
// (indent 2, temp file + rename). Neither prunes old entries, so valid journals keep growing.
async function writeJournal(root,relative,data){
 const file=path.join(root,...relative.split('/'));
 await fs.mkdir(path.dirname(file),{recursive:true});
 await fs.writeFile(file+'.tmp',JSON.stringify(data,null,2)+'\n');
 await fs.rename(file+'.tmp',file);
 return (await fs.stat(file)).size;
}
function bigJournals(count){
 const key=i=>i.toString(16).padStart(64,'0');
 const history={records:{},captions:[]},soutu={};
 for(let i=0;i<count.taobao;i++){
  history.records[key(i)]={file:`夏季新款-${i}.mp4`,status:i===1?'submitted':i===2?'unknown':'published',at:'2026-11-19T01:00:00.000Z'};
  history.captions.push(`夏季新款透气网面运动鞋男款轻便减震跑步鞋第${i}条`);
 }
 for(let i=0;i<count.soutu;i++)soutu[key(i)]={id:key(i),group:i===7?'红海/黑色':'蓝色',itemId:String(778899+i),title:`夏季新款商品标题${i}`,
  status:i===7?'pending':'published',expectedCover:`cover-${i}.jpg`,time:'2026-11-20T01:00:00.000Z'};
 return {history,soutu};
}

test('valid journals over the former 2MB/1MB caps are counted; over stateMaxBytes they are unchecked, never broken',async t=>{
 const root=await temporary(t);
 const {history,soutu}=bigJournals({taobao:8000,soutu:5000});
 assert.ok(await writeJournal(root,'taobao/history.json',history)>2*1024*1024,'history.json must exceed the former 2MB cap');
 assert.ok(await writeJournal(root,'taobao-soutu/publish-state.json',soutu)>1024*1024,'publish-state.json must exceed the former 1MB cap');
 const {diagnostics,watcher}=setup(root);
 const opens=name=>watcher.calls.filter(c=>c.name==='open'&&path.basename(String(c.args[0]))===name).length;
 const first=await diagnostics.overview();
 assert.deepEqual(first.tools.taobao.records,{published:7998,submitted:1,unknown:1});
 assert.equal(first.tools.taobao.recordsError,false);assert.equal(first.tools.taobao.recordsUnchecked,false);
 const big=first.tools['taobao-soutu'];
 assert.deepEqual(big.records,{published:4999,pending:1});assert.equal(big.pendingGroup,'红海/黑色');
 assert.equal(big.recordsError,false);assert.equal(big.recordsUnchecked,false);
 // An unchanged file is parsed once; a same-size rewrite (submitted -> published) is picked up.
 assert.deepEqual((await diagnostics.overview()).tools.taobao.records,first.tools.taobao.records);
 assert.equal(opens('history.json'),1);assert.equal(opens('publish-state.json'),1);
 history.records[(1).toString(16).padStart(64,'0')].status='published';
 await writeJournal(root,'taobao/history.json',history);
 assert.deepEqual((await diagnostics.overview()).tools.taobao.records,{published:7999,submitted:0,unknown:1});
 assert.equal(opens('history.json'),2);
 // Beyond the cost bound nothing is read and nothing is reported as broken.
 const capped=setup(root,{extra:{stateMaxBytes:64*1024}});
 const tools=(await capped.diagnostics.overview()).tools;
 assert.equal(tools.taobao.records,null);assert.equal(tools.taobao.recordsError,false);assert.equal(tools.taobao.recordsUnchecked,true);
 const over=tools['taobao-soutu'];
 assert.equal(over.records,null);assert.equal(over.recordsError,false);assert.equal(over.recordsUnchecked,true);assert.equal(over.pendingGroup,null);
 assert.equal(capped.watcher.calls.filter(c=>c.name==='open'&&/history\.json|publish-state\.json/.test(String(c.args[0]))).length,0);
 // A broken file stays an error whatever its size.
 await put(root,'taobao/history.json','{"records":');
 assert.equal((await capped.diagnostics.overview()).tools.taobao.recordsError,true);
});

test('a separate launchd reminder checker is never reported as stopped by an unreadable config',async t=>{
 const root=await temporary(t);
 const reminders={status:()=>({enabled:false,at:'09:05',hasWebhook:true,recipient:'ou_abcdef1234567890',hasLogin:true,nativeAgent:true,message:'内置飞书配置无法读取，请重新安装内部版或手动保存配置'})};
 const {diagnostics}=setup(root,{extra:{reminders}});
 const reminder=(await diagnostics.overview()).tools['taobao-reminders'];
 assert.equal(reminder.nativeAgent,true);assert.equal(reminder.configUnreadable,false);
});

test('sycm needs a saved login as evidence, and an unreadable reminder config is flagged',async t=>{
 const root=await temporary(t);
 await put(root,'sycm/auth/chrome_profile/Default/Preferences','{}'); // created even when the login was abandoned
 const reminders={status:()=>({enabled:false,at:'09:05',hasWebhook:false,recipient:'',hasLogin:true,nativeAgent:false,message:'本机提醒配置无法读取，请重新保存配置'})};
 const {diagnostics}=setup(root,{extra:{reminders}});
 let tools=(await diagnostics.overview()).tools;
 assert.equal(tools.sycm.login.evidence,false);assert.equal(tools.sycm.login.at,null);
 assert.equal(tools['taobao-reminders'].configUnreadable,true);assert.equal(tools['taobao-reminders'].lastFailed,true);
 await put(root,'sycm/auth/sycm_state.json','{"cookies":[]}');
 tools=(await diagnostics.overview()).tools;
 assert.equal(tools.sycm.login.evidence,true);assert.equal(typeof tools.sycm.login.at,'string');
});

test('an empty userData directory still returns a complete overview and snapshot',async t=>{
 const root=await temporary(t);
 const {diagnostics}=setup(root);
 const overview=await diagnostics.overview(),snapshot=await diagnostics.snapshot();
 assert.equal(overview.incomplete,false);
 assert.deepEqual(overview.tools.taobao.records,{published:0,submitted:0,unknown:0});
 assert.deepEqual(overview.tools['taobao-stock'].jobs,{checked:0,resumable:0,needsReview:0,unchecked:0,latest:null});
 assert.equal(overview.tools.sycm.lastTask,null);assert.equal(overview.tools.monthly.lastPreview,null);
 assert.equal(overview.tools['taobao-soutu'].staleLock,null);
 assert.deepEqual(overview.env.components,{ok:false,missing:['monthly','return-rate','sycm','taobao-reminders','taobao-stock','erp-stock-rules']});
 assert.deepEqual(snapshot.errors,[]);assert.deepEqual(snapshot.update,{pending:false,failures:[]});
 assert.deepEqual(snapshot.logs,{startup:null,install:null,events:null});
 assert.equal(snapshot.logins.find(l=>l.id==='kuaimai-api').note,'未导入；进入退货率报表时会检查本机库存监控台配置');
 assert.deepEqual(await fs.readdir(root),[]);
});

test('a login restore that never settles yields evidence null within the time limit',async t=>{
 const root=await temporary(t);await plant(root);
 const {diagnostics}=setup(root,{loginReady:new Promise(()=>{})});
 const started=Date.now();
 const overview=await diagnostics.overview();
 assert.ok(Date.now()-started<1600);
 assert.equal(overview.tools.report.login.evidence,null);assert.equal(overview.tools.price.login.evidence,null);
 assert.equal(overview.tools.monthly.login.evidence,null);
 assert.equal((await diagnostics.snapshot()).logins[0].state,'unknown');
});

test('a hung probe is cut off at the deadline and reported as incomplete',async t=>{
 const root=await temporary(t);await plant(root);
 const hung=new Proxy(fs,{get(target,name){
  if(name==='readdir')return (directory,...rest)=>String(directory).includes('monthly-runs')?new Promise(()=>{}):target.readdir(directory,...rest);
  return target[name];
 }});
 const {diagnostics}=setup(root,{fs:hung,extra:{timeoutMs:400}});
 const started=Date.now();
 const overview=await diagnostics.overview();
 assert.ok(Date.now()-started<1000);
 assert.equal(overview.incomplete,true);
 assert.deepEqual(overview.tools.monthly,{error:'超时'});
 assert.equal(overview.tools['taobao-stock'].jobs.resumable,1);
});

test('registerReadOnly rejects foreign senders and redacts thrown errors',async()=>{
 const handlers={},ipcMain={handle:(name,fn)=>{handlers[name]=fn;}};
 const frame={},webContents={mainFrame:frame};let destroyed=false;
 const win={isDestroyed:()=>destroyed,get webContents(){if(destroyed)throw Error('Object has been destroyed');return webContents;}};
 const redact=createRedactor({home:'/Users/zhao',platform:'darwin'});
 let received;
 registerReadOnly({ipcMain,win,redact},'business-toolkit-overview',async(...args)=>{received=args;return {fine:true};});
 registerReadOnly({ipcMain,win,redact},'business-ops-snapshot',async()=>{throw Error('读取 /Users/zhao/x 失败 sk-SECRET123456');});
 const good={sender:webContents,senderFrame:frame};
 assert.deepEqual(await handlers['business-toolkit-overview'](good,'ignored',{evil:true}),{ok:true,data:{fine:true}});
 assert.deepEqual(received,[]);
 await assert.rejects(handlers['business-toolkit-overview']({sender:{},senderFrame:frame}),/非法调用来源/);
 await assert.rejects(handlers['business-toolkit-overview']({sender:webContents,senderFrame:{}}),/非法调用来源/);
 const failed=await handlers['business-ops-snapshot'](good);
 assert.equal(failed.ok,false);assert.ok(!failed.error.includes('sk-SECRET'));assert.ok(!failed.error.includes('/Users/zhao'));
 destroyed=true;
 await assert.rejects(handlers['business-toolkit-overview'](good),/非法调用来源/);
});

test('activity skips quiet status calls, never stores arguments, redacts and rotates the failure log',async t=>{
 const root=await temporary(t),directory=path.join(root,'logs');
 const redact=createRedactor({home:root,platform:process.platform});
 const activity=createActivity({directory,redact,maxBytes:400});
 activity.record({action:'return-rate-status',tool:'return-rate',ok:true,ms:3});
 activity.record({action:'taobao-reminders-status',tool:'taobao-reminders',ok:true,ms:2});
 assert.deepEqual(activity.recent(),[]);
 activity.record({action:'taobao-reminders-save',tool:'taobao-reminders',ok:false,ms:15,error:`Webhook 无效 ${WEBHOOK} sk-PLANTEDKEY123`,args:[{webhook:WEBHOOK}]});
 activity.record({action:'price-query',tool:'price',ok:true,ms:1200.6});
 const recent=activity.recent();
 assert.equal(recent.length,2);assert.equal(recent[0].action,'price-query');assert.equal(recent[0].ms,1201);
 assert.deepEqual(Object.keys(recent[1]).sort(),['action','at','error','id','ms','ok','tool']);
 await activity.flush();
 const log=await fs.readFile(path.join(directory,'toolkit-errors.log'),'utf8');
 assert.ok(!log.includes('hook/0000')&&!log.includes('sk-PLANTED')&&!log.includes('args'));
 assert.deepEqual(Object.keys(JSON.parse(log.trim())).sort(),['action','at','id','message','ms','tool']);
 for(let i=0;i<12;i++)activity.record({action:'sycm-start',tool:'sycm',ok:false,ms:i,error:`第 ${i} 次失败`});
 await activity.flush();
 const names=(await fs.readdir(directory)).sort();
 assert.deepEqual(names,['toolkit-errors.1.log','toolkit-errors.log']);
 const errors=await activity.errors();
 assert.ok(errors.length>0&&errors.length<=30);assert.equal(errors[0].message,'第 11 次失败');
 assert.ok(errors.every((e,i)=>i===0||e.at<=errors[i-1].at));
 const quiet=path.join(root,'quiet');
 const memory=createActivity({directory:quiet,redact,persist:false});
 memory.record({action:'sycm-start',tool:'sycm',ok:false,ms:1,error:'失败 sk-PLANTEDKEY123'});
 await memory.flush();
 await assert.rejects(fs.stat(quiet));
 assert.equal((await memory.errors())[0].message,'失败 sk-[已隐藏]');
 const limited=createActivity({directory:quiet,redact,persist:false,limit:3});
 for(let i=0;i<5;i++)limited.record({action:'report-query',tool:'report',ok:true,ms:i});
 assert.equal(limited.recent().length,3);
});
