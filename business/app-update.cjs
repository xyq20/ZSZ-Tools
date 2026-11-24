const fs=require('node:fs/promises');
const {createWriteStream}=require('node:fs');
const {verifyFile}=require('./windows-update.cjs');
const path=require('node:path');
const https=require('node:https');
const crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const {Transform}=require('node:stream');
const {spawn}=require('node:child_process');
const {prepareHot,assertPrepared,launchHot}=require('./hot-update.cjs');
const {setTimeout:delay}=require('node:timers/promises');
const {fetchManifest,evaluateManifest,newer}=require('../updater.cjs');
const REPO='/xyq20/ZSZ-Tools/releases/download/';
function validateAsset(release,current,platform,arch){
 const result=evaluateManifest(release,current,platform,arch);
 if(result.status!=='available')return result;
 let asset=release.assets.find(a=>a.browser_download_url===result.download);
 let kind=platform==='win32'?'windows-full':'mac-hot';
 if(platform==='win32'){
  const suffix=result.latest+'-win-'+arch+'.zip';
  const packages=release.assets.filter(a=>a.name==='-'+suffix||a.name==='钊叔工具箱-'+suffix);
  if(packages.length>1)throw Error('Windows 更新包重复');
  if(packages.length){asset=packages[0];kind='windows-hot';}
 }
 if(!asset||!Number.isSafeInteger(asset.size)||asset.size<=0||asset.size>2*1024**3||!/^sha256:[a-f0-9]{64}$/.test(asset.digest||''))throw Error('新版安装包缺少完整性校验信息，请稍后重试');
 const url=allowedURL(asset.browser_download_url,true);
 if(decodeURIComponent(url.pathname)!==REPO+release.tag_name+'/'+asset.name||url.search||url.hash)throw Error('安装包版本与发布记录不一致');
 return {...result,download:url.href,kind,size:asset.size,sha256:asset.digest.slice(7)};
}
function allowedURL(value,initial=false){
 const u=new URL(value);
 if(u.protocol!=='https:'||u.username||u.password||u.port)throw Error('更新下载地址无效');
 if(initial?u.hostname!=='github.com'||!u.pathname.startsWith(REPO):!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(u.hostname))throw Error('更新下载跳转地址不受信任');
 return u;
}
function response(url,signal,redirects=0){
 return new Promise((resolve,reject)=>{
  const u=allowedURL(url,redirects===0);
  const req=https.get(u,{signal,headers:{'User-Agent':'ZSZ-Tools-Updater','Accept':'application/octet-stream'}},res=>{
   if([301,302,303,307,308].includes(res.statusCode)){
    res.resume();if(redirects>=5||!res.headers.location)return reject(Error('更新下载跳转次数异常'));
    response(new URL(res.headers.location,u).href,signal,redirects+1).then(resolve,reject);return;
   }
   if(res.statusCode!==200){res.resume();return reject(Error('下载失败：HTTP '+res.statusCode));}
   resolve(res);
  });req.setTimeout(30000,()=>req.destroy(Error('下载超时，请重试')));req.on('error',reject);
 });
}
async function downloadFile(info,file,{signal,onProgress=()=>{},getResponse=response}={}){
 const partial=file+'.part';await fs.rm(partial,{force:true});
 try{
  const input=await getResponse(info.download,signal);let bytes=0,lastProgress=0;const hash=crypto.createHash('sha256');
  const meter=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;if(bytes>info.size)return done(Error('安装包超过预期大小'));hash.update(chunk);if(Date.now()-lastProgress>=100||bytes===info.size){lastProgress=Date.now();onProgress(bytes,info.size);}done(null,chunk);}});
  await pipeline(input,meter,createWriteStream(partial,{flags:'wx',mode:0o600}),{signal});
  if(bytes!==info.size||hash.digest('hex')!==info.sha256)throw Error('安装包校验失败，请重新下载');
  await fs.rename(partial,file);
 }catch(e){await fs.rm(partial,{force:true});throw e;}
}
async function waitForWindowsHelper(child,ready,log){
 const until=Date.now()+10000;
 while(child.exitCode===null&&child.signalCode===null&&Date.now()<until){
  if(await fs.access(ready).then(()=>true,()=>false))return;
  await delay(100);
 }
 if(child.exitCode===null&&child.signalCode===null)child.kill();
 const detail=await fs.readFile(log,'utf8').then(text=>text.trim().slice(-500),()=>null);
 const reason=detail||`启动未确认（退出码 ${child.exitCode??'未知'}）`;
 throw Error(`Windows 更新助手未就绪：${reason}。日志：${log}`);
}
async function clearWindowsReadyFiles(directory){
 const names=await fs.readdir(directory);
 for(const name of names){
  if(/^helper-[a-f0-9]{32}\.ready$/.test(name))await fs.unlink(path.join(directory,name)).catch(error=>{if(error.code!=='ENOENT')throw error;});
 }
}
async function clearCompletedWindowsAttempts(root,version){
 for(const entry of await fs.readdir(root,{withFileTypes:true})){
  const match=/^(\d+\.\d+\.\d+)-win32-(?:x64|arm64)$/.exec(entry.name);
  if(entry.isDirectory()&&match&&!newer(match[1],version)){
   await clearWindowsReadyFiles(path.join(root,entry.name));
  }
 }
}
async function launchHelper({platform,directory,file,info,token,executable,windowsNode},spawnProcess=spawn){
 if(platform!=='win32')throw Error('完整安装助手仅支持 Windows');
 await clearWindowsReadyFiles(directory);
 const runtime=windowsNode||path.join(process.resourcesPath,'python/Lib/site-packages/playwright/driver/node.exe');
 const command=path.join(directory,'update-node.exe');
 await fs.copyFile(runtime,command);
 const helper=path.join(directory,'windows-update.cjs');
 await fs.writeFile(helper,await fs.readFile(path.join(__dirname,'windows-update.cjs')),{mode:0o600});
 const ready=path.join(directory,'helper-'+token+'.ready');
 const args=[helper,JSON.stringify({parentPid:process.pid,file,info:{size:info.size,sha256:info.sha256},executable,directory,token})];
 const helperLog=path.join(directory,'install-helper.log');
 const handle=await fs.open(helperLog,'w',0o600);
 try{
  const child=spawnProcess(command,args,{cwd:directory,detached:true,windowsHide:true,stdio:['ignore',handle.fd,handle.fd]});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  await waitForWindowsHelper(child,ready,helperLog);
  child.unref();
 }finally{
  await handle.close();
  await fs.rm(ready,{force:true}).catch(()=>{});
 }
}
async function atomicJSON(file, value) {
 const temp=file+'.'+crypto.randomUUID()+'.tmp';
 try {
  await fs.writeFile(temp,JSON.stringify(value),{mode:0o600,flag:'wx'});
  await fs.rename(temp,file);
 } finally {await fs.rm(temp,{force:true});}
}

async function removePending(file,token) {
 try {
  const value=JSON.parse(await fs.readFile(file,'utf8'));
  if(value.token===token)await fs.rm(file,{force:true});
 } catch(error){if(error.code!=='ENOENT')throw error;}
}

function createUpdater({app,manifestUrl,business,notify=()=>{},platform=process.platform,arch=process.arch,
 fetchRelease=fetchManifest,getNetworkRoute=async()=>null,downloader=downloadFile,prepare=prepareHot,
 validatePrepared=assertPrepared,launch=launchHot,launchFull=launchHelper}) {
 const root=path.join(app.getPath('userData'),'updates');
 const pending=path.join(root,'pending.json');
 let state={status:'idle',current:app.getVersion()},info,file,directory,prepared,token,operation,controller;
 let canQuit=false,disposed=false;
 const record = require('./update-log.cjs').createUpdateLog(root, require('node:os').homedir());
 const emit=(patch,origin)=>{state={...state,...patch};record(state,origin);notify({...state});return {...state};};
 const run=fn=>{if(operation)return operation;operation=fn().finally(()=>{operation=null;});return operation;};
 async function discard(){
  if(prepared){await fs.rm(prepared.staged,{recursive:true,force:true,maxRetries:4,retryDelay:100});prepared=null;}
 }
 return {
  state:()=>({...state}),canQuit:()=>canQuit,isInstalling:()=>state.status==='installing',
  check(origin='手动'){
   if(disposed)return Promise.resolve({...state});
   if(operation && state.status==='checking')return operation;
   if(operation||['downloaded','installing'].includes(state.status))return Promise.resolve({...state});
   return run(async()=>{
    emit({status:'checking',latest:null,message:'正在检查更新…'},origin);
    try{
     info=validateAsset(await fetchRelease(manifestUrl),app.getVersion(),platform,arch);
     let message='';
     if(info.kind==='windows-full'&&require('./windows-versions.cjs').slotStore(app.getPath('exe'))){
      info={...info,status:'unsupported'};message='此版本仅提供完整安装包，请从工具箱发布页下载安装，或稍后重新检查在线更新。';
     }
     if(info.status==='available'){
      directory=path.join(root,info.latest+'-'+platform+'-'+arch);
      const reason=await fs.readFile(path.join(directory,'healthy.failed'),'utf8').catch(()=>null);
      if(reason)message='上次更新未完成：'+reason.trim().slice(0,1000)+'。可重新准备更新。';
     }
     return emit({...info,message});
    }catch(error){info=null;return emit({status:'error',message:error.message});}
   });
  },
  download(){
   if(operation)return operation;
   if(state.status==='downloaded'||disposed)return Promise.resolve({...state});
   return run(async()=>{
    if(!info||info.status!=='available')throw Error('请先检查更新');
    controller=new AbortController();
    const {signal}=controller;
    emit({status:'downloading',percent:0,bytes:0,total:info.size,network:null,message:'正在下载更新…'});
    try{
     await discard();
     await fs.mkdir(directory,{recursive:true,mode:0o700});
     file=path.join(directory,info.kind==='mac-hot'?'installer.dmg':info.kind==='windows-hot'?'payload.zip':'installer.exe');
     const cached=await verifyFile(file,info).then(()=>true,()=>false);
     signal.throwIfAborted();
     if(!cached){
      emit({network:await getNetworkRoute(info.download)});
      await downloader(info,file,{signal,onProgress:(bytes,total)=>emit({percent:Math.floor(bytes/total*100),bytes,total})});
     }
     signal.throwIfAborted();
     token=crypto.randomBytes(16).toString('hex');
     if(info.kind!=='windows-full'){
      emit({status:'preparing',percent:100,message:'正在后台准备新版。可以关闭此窗口，继续使用工具箱。'});
      prepared=await prepare({platform,file,directory,current:app.getVersion(),version:info.latest,
       executable:app.getPath('exe'),resources:process.resourcesPath,token,signal});
      signal.throwIfAborted();
     }
     return emit({status:'downloaded',percent:100,message:prepared?
      '新版已准备好。保存当前工作后，点击「重启更新」即可打开新版。':
      '此版本提供完整安装包。重启后将执行安装，完成后自动打开工具箱。'});
    }catch(error){
     await discard();
     return emit({status:'available',message:signal.aborted?'下载已取消，可重新准备更新。':error.message,percent:0});
    }finally{controller=null;}
   });
  },
  cancel(){controller?.abort();},
  async dispose(){disposed=true;controller?.abort();await operation?.catch(()=>{});if(!canQuit)await discard();},
  install(){
   if(operation)return operation;
   return run(async()=>{
    if(disposed||state.status!=='downloaded'||!file)throw Error('请先完成更新准备');
    if(!app.isPackaged)throw Error('请在已安装的工具箱中执行更新');
    if(business.isBusy())throw Error('任务正在执行，请完成后再重启更新');
    const clickedAt=Date.now();
    business.beginUpdate();
    emit({status:'installing',message:'正在保存登录状态，即将打开新版…'});
    try{
     if(prepared){
      try{await validatePrepared(prepared);}
      catch(error){await discard();throw Error('已准备的新版文件有变化，请重新准备更新');}
     }else{await verifyFile(file,info);}
     await business.flushLogin({keepSchedule:true});
     await Promise.all(['healthy','healthy.failed'].map(name=>fs.rm(path.join(directory,name),{force:true})));
     const version=info.latest,executable=app.getPath('exe');
     await atomicJSON(pending,{schema:prepared?2:1,version,directory,token,clickedAt});
     if(prepared)await launch({platform,directory,version,prepared,token,executable,clickedAt,currentVersion:app.getVersion()});
     else await launchFull({platform,directory,file,info,token,executable});
     canQuit=true;app.quit();return {...state};
    }catch(error){
     business.endUpdate();
     await removePending(pending,token);
     emit({status:prepared||info.kind==='windows-full'?'downloaded':'available',message:'更新未启动：'+error.message});
     throw error;
    }
   });
  },
 };
}

async function acknowledgeUpdate(app,platform=process.platform,windowState=null) {
 const root=path.join(app.getPath('userData'),'updates'),pending=path.join(root,'pending.json');
 let value;
 try{value=JSON.parse(await fs.readFile(pending,'utf8'));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return;throw error;}
 if(!/^[a-f0-9]{32}$/.test(value.token)||!/^\d+\.\d+\.\d+$/.test(value.version)||typeof value.directory!=='string'
   ||path.dirname(value.directory)!==root||!['x64','arm64'].some(arch=>path.basename(value.directory)===value.version+'-'+platform+'-'+arch))return;
 if(value.version!==app.getVersion()){
  const detail=await fs.readFile(path.join(value.directory,'healthy.failed'),'utf8').catch(()=>null);
  if(detail){
   await removePending(pending,value.token);
   if(platform==='win32')await clearWindowsReadyFiles(value.directory);
   return {detail,log:path.join(value.directory,'install.log')};
  }
  return;
 }
 const launched=process.argv.includes('--toolkit-update-token='+value.token);
 if(value.schema===2){
  if(!launched||!windowState?.visible||!windowState.interactive)return;
  await atomicJSON(path.join(value.directory,'window-'+value.token+'.json'),{...windowState,
   token:value.token,version:value.version,pid:process.pid,executable:process.execPath,readyAt:Date.now()});
  return;
 }
 if(platform==='darwin'&&!launched)return;
 await fs.writeFile(path.join(value.directory,'healthy'),'ok',{mode:0o600});
 await removePending(pending,value.token);
 if(platform==='win32'){
  await clearCompletedWindowsAttempts(root,value.version);
  await fs.rm(path.join(value.directory,'healthy.failed'),{force:true});
 }
}
module.exports={validateAsset,allowedURL,downloadFile,verifyFile,launchHelper,createUpdater,acknowledgeUpdate};
