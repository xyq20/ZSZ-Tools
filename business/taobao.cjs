const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
const {chromium}=require('playwright-core');
const {scanFolder}=require('../modules/taobao/scripts/catalog');
const {generateChoices}=require('../modules/taobao/scripts/model');
const {readState,writeState,assertRunnable}=require('../modules/taobao/scripts/state');
const {URL,frame,upload,collectProducts,fetchTopics,inspectMedia}=require('../modules/taobao/scripts/platform');
const {runPreparedBatch}=require('../modules/taobao/scripts/run-prepared-batch');
const {finalizeBatch}=require('../modules/taobao/scripts/finalize-batch');
const {armPublicationResult,waitPublicationResult}=require('../modules/taobao/scripts/publication-result');
function browserPath(){
 const candidates=process.platform==='darwin'?['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']:[process.env.PROGRAMFILES,process.env['PROGRAMFILES(X86)'],process.env.LOCALAPPDATA].filter(Boolean).flatMap(p=>[path.join(p,'Google/Chrome/Application/chrome.exe'),path.join(p,'Microsoft/Edge/Application/msedge.exe')]);
 return candidates.find(p=>fs.existsSync(p));
}
function createTaobaoTool({app,win,dialog,safeStorage,progress}){
 const dir=path.join(app.getPath('userData'),'taobao'),stateFile=path.join(dir,'history.json'),keyFile=path.join(dir,'model-key.bin');
 let context,page,batch,choices,ready=false,submitting=false,ownsDraft=false;
 async function journal(){return readState(stateFile);}
 function apiKey(){if(!fs.existsSync(keyFile))return '';if(!safeStorage.isEncryptionAvailable())throw Error('本机系统加密不可用，请恢复系统钥匙串后重试');return safeStorage.decryptString(fs.readFileSync(keyFile));}
 async function settings(){return {hasKey:fs.existsSync(keyFile),model:'deepseek-flash',browser:browserPath()?path.basename(browserPath()):null};}
 async function saveKey(key){if(typeof key!=='string'||!key.trim())throw Error('请输入有效密钥');if(!safeStorage.isEncryptionAvailable())throw Error('系统加密不可用，不能保存密钥');await fsp.mkdir(dir,{recursive:true,mode:0o700});await fsp.writeFile(keyFile,safeStorage.encryptString(key.trim()),{mode:0o600});return settings();}
 async function login(){
  if(context&&page&&!page.isClosed()){await page.bringToFront();return {message:'已打开淘宝窗口'};}
  const executablePath=browserPath();if(!executablePath)throw Error('请先安装 Google Chrome 或 Microsoft Edge，再打开淘宝登录');
  context=await chromium.launchPersistentContext(path.join(dir,'browser-profile'),{executablePath,headless:false,viewport:null,locale:'zh-CN',acceptDownloads:false});
  context.setDefaultTimeout(20000);page=context.pages()[0]||await context.newPage();
  context.on('close',()=>{context=null;page=null;ready=false;});
  await page.goto(URL,{waitUntil:'domcontentloaded'});return {message:'请在浏览器登录淘宝，并保持批量发布页面打开。'};
 }
 async function waitEditor(){
  let editor=page.frames().find(f=>f.url().includes('/qianniu-batch-video'));
  if(!editor){try{editor=await page.waitForEvent('framenavigated',{predicate:f=>f.url().includes('/qianniu-batch-video'),timeout:45000});}catch{throw Error('淘宝编辑页未就绪，请完成登录并进入批量发布后重试');}}
  await editor.locator('#root').waitFor({state:'attached',timeout:45000});return editor;
 }
 async function choose(){
  if(submitting)throw Error('发布结果尚待确认，不能切换批次');
  const r=await dialog.showOpenDialog(win,{title:'选择具体月份/周次的视频目录',properties:['openDirectory']});if(r.canceled)return null;
  ready=false;choices=null;const state=await journal();batch=await scanFolder(r.filePaths[0],state.records);return batch;
 }
 async function prepare(){
  ready=false;choices=null;
  if(!batch)throw Error('请先选择视频目录');
  if(!apiKey())throw Error('请先保存 DeepSeek API 密钥');
  const state=await journal();const refreshed=await scanFolder(batch.folder,state.records);
  if(JSON.stringify(refreshed.rows.map(x=>[x.file,x.fingerprint]))!==JSON.stringify(batch.rows.map(x=>[x.file,x.fingerprint])))throw Error('目录内容已变化，请重新选择目录');
  batch=refreshed;assertRunnable(batch.rows);
  if(!context||!page||page.isClosed())throw Error('请先打开淘宝并登录');
  if(ownsDraft){progress('正在清理本工具上次未提交的草稿，重新准备批次…');await page.goto(URL,{waitUntil:'domcontentloaded'});}
  await waitEditor();
  progress('正在读取视频时长，用于校验活动参与要求…');const media=await inspectMedia(context,batch.rows);await page.bringToFront();
  progress('开始上传视频');ownsDraft=true;await upload(page,batch.rows,progress);
  const items=await collectProducts(page,media,progress);
  progress('正在读取当前推荐与服饰话题及活动要求…');const topics=await fetchTopics(page);
  if(!topics.length)throw Error('平台没有返回话题候选');
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  progress(`正在生成 ${items.length} 条文案，从 ${topics.length} 个实时话题中选择…`);
  choices=await generateChoices({items,topics,date,key:apiKey(),history:state.captions});
  progress('正在填写商品、文案、话题、标签及声明…');await runPreparedBatch(page,choices,{publish:false});
  ready=true;progress(`整批 ${choices.length} 条已核验，请核对清单和淘宝页面，再确认发布。`);
  return {status:'ready',choices:choices.map(({file,caption,product_name,product_id,topic_title})=>({file,caption,product_name,product_id,topic_title}))};
 }
 async function publish(){
  if(!ready||!choices||submitting)throw Error('请先完成上传、填写和整批核验');
  const confirm=await dialog.showMessageBox(win,{type:'question',buttons:['取消','确认发布到淘宝'],defaultId:0,cancelId:0,message:`确认将 ${choices.length} 条视频发布到当前淘宝店铺？`,detail:'请核对淘宝窗口中的店铺账号、视频内容、商品关联、文案与话题。发布后不能通过工具箱撤回。'});
  if(confirm.response!==1)return null;
  const state=await journal();const current=await scanFolder(batch.folder,state.records);assertRunnable(current.rows);
  if(JSON.stringify(current.rows.map(x=>[x.file,x.fingerprint]))!==JSON.stringify(batch.rows.map(x=>[x.file,x.fingerprint])))throw Error('发布前视频文件发生变化，请重新选择并核验');
  await finalizeBatch(page,choices,{publish:false});
  await armPublicationResult(page);
  // Persist before click. A crash or timeout must never unlock a potentially published batch.
  for(const row of batch.rows)state.records[row.fingerprint]={file:row.file,status:'submitted',at:new Date().toISOString()};
  await writeState(stateFile,state);ready=false;submitting=true;
  try{
   progress('正在提交整批视频，等待淘宝返回结果；请保持浏览器打开…');
   await finalizeBatch(page,choices,{publish:true});
   const result=await waitPublicationResult(page,choices);
   for(const row of batch.rows)state.records[row.fingerprint].status=result.status;
   if(result.status==='published')state.captions.push(...choices.map(c=>c.caption));
   await writeState(stateFile,state);progress(result.message);return result;
  }catch(error){
   for(const row of batch.rows)state.records[row.fingerprint].status='unknown';await writeState(stateFile,state);
   throw Error('发布结果待核实，已锁定本批次，请到淘宝作品管理检查。'+error.message);
  }finally{submitting=false;}
 }
 async function history(){const state=await journal();return Object.values(state.records).sort((a,b)=>b.at.localeCompare(a.at));}
 return {settings,saveKey,login,choose,prepare,publish,history,cleanup:async()=>{if(context)await context.close();}};
}
module.exports={createTaobaoTool,browserPath};
