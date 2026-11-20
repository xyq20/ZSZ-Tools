const fs=require('node:fs/promises');
const {createReadStream,createWriteStream}=require('node:fs');
const path=require('node:path');
const https=require('node:https');
const crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const {Transform}=require('node:stream');
const {execFile,spawn}=require('node:child_process');
const {promisify}=require('node:util');
const {setTimeout:delay}=require('node:timers/promises');
const exec=promisify(execFile);
const {fetchManifest,evaluateManifest}=require('../updater.cjs');
const REPO='/xyq20/ZSZ-Tools/releases/download/';
function validateAsset(release,current,platform,arch){
 const result=evaluateManifest(release,current,platform,arch);
 if(result.status!=='available')return result;
 const asset=release.assets.find(a=>a.browser_download_url===result.download);
 if(!asset||!Number.isSafeInteger(asset.size)||asset.size<=0||asset.size>2*1024**3||!/^sha256:[a-f0-9]{64}$/.test(asset.digest||''))throw Error('新版安装包缺少完整性校验信息，请稍后重试');
 const url=new URL(result.download);
 if(!url.pathname.startsWith(REPO+release.tag_name+'/'))throw Error('安装包版本与发布记录不一致');
 return {...result,size:asset.size,sha256:asset.digest.slice(7)};
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
async function verifyFile(file,info){
 const stat=await fs.lstat(file);if(!stat.isFile()||stat.size!==info.size)throw Error('安装包大小校验失败，请重新下载');
 const hash=crypto.createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
 if(hash.digest('hex')!==info.sha256)throw Error('安装包校验失败，请重新下载');
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
async function prepareMac({file,directory,version,executable,token}){
 const target=path.resolve(executable,'../../..');
 if(!target.endsWith('.app')||target.includes('/AppTranslocation/')||target.startsWith('/Volumes/'))throw Error('请先将工具箱安装到“应用程序”后再更新');
 await fs.access(path.dirname(target),require('node:fs').constants.W_OK);
 const mount=path.join(directory,'mount'),staged=path.join(path.dirname(target),`.toolkit-update-${token}.app`),backup=path.join(path.dirname(target),`.toolkit-backup-${token}.app`);
 await fs.mkdir(mount,{recursive:true});
 let attached=false;
 try{
  await exec('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,file],{timeout:120000});attached=true;
  const source=path.join(mount,'钊叔工具箱.app'),plist=path.join(source,'Contents/Info.plist');
  const read=key=>exec('/usr/bin/plutil',['-extract',key,'raw','-o','-',plist]);
  if((await read('CFBundleIdentifier')).stdout.trim()!=='local.team.toolkit'||(await read('CFBundleShortVersionString')).stdout.trim()!==version)throw Error('安装包内程序身份或版本不匹配');
  const binary=(await read('CFBundleExecutable')).stdout.trim();if(binary!=='钊叔工具箱')throw Error('安装包启动程序不匹配');
  await exec('/usr/bin/ditto',[source,staged],{timeout:180000});
  return {target,staged,backup,binary};
 }catch(e){await fs.rm(staged,{recursive:true,force:true});throw e;}
 finally{if(attached)await exec('/usr/bin/hdiutil',['detach',mount],{timeout:30000}).catch(()=>{});}
}
function macScript(){return `#!/bin/sh
set -eu
parent="$1"; target="$2"; staged="$3"; backup="$4"; ack="$5"; token="$6"; binary="$7"
i=0
while kill -0 "$parent" 2>/dev/null; do
 i=$((i+1)); [ "$i" -lt 60 ] || exit 1
 sleep 1
done
/bin/mv "$target" "$backup"
if ! /bin/mv "$staged" "$target"; then /bin/mv "$backup" "$target"; /usr/bin/open "$target"; exit 1; fi
"$target/Contents/MacOS/$binary" "--toolkit-update-token=$token" >> "$ack.log" 2>&1 &
child=$!
i=0
while [ "$i" -lt 60 ]; do
 if [ -f "$ack" ]; then /bin/rm -rf "$backup"; exit 0; fi
 kill -0 "$child" 2>/dev/null || break
 i=$((i+1)); sleep 1
done
kill "$child" 2>/dev/null || true
sleep 2
kill -9 "$child" 2>/dev/null || true
/bin/mv "$target" "$staged"
/bin/mv "$backup" "$target"
printf '新版启动未完成，已恢复旧版。' > "$ack.failed"
/usr/bin/open "$target"
`;}
function windowsScript(){return `param([int]$ParentPid,[string]$Installer,[string]$Digest,[string]$Log,[string]$Ready,[string]$AppExe,[string]$Healthy)
$ErrorActionPreference='Stop'
$oldAppExited=$false
$installerProcess=$null
$launchedApp=$null
try {
 '正在等待旧版工具箱退出' | Set-Content -LiteralPath $Log -Encoding UTF8
 'ready' | Set-Content -LiteralPath $Ready -Encoding ASCII
 $p=Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
 if ($p -and -not $p.WaitForExit(15000)) { throw '旧版工具箱未退出，请关闭工具箱后重试' }
 $oldAppExited=$true
 if ((Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLower() -ne $Digest) { throw '安装包校验失败' }
 '正在后台应用更新' | Add-Content -LiteralPath $Log -Encoding UTF8
 $installerProcess=Start-Process -FilePath $Installer -ArgumentList @('/S','--updated') -PassThru
 if (-not $installerProcess.WaitForExit(300000)) { throw '后台更新仍未结束。请检查 Windows 管理员授权提示' }
 if ($installerProcess.ExitCode -ne 0) { throw ('后台更新失败，退出码：'+$installerProcess.ExitCode) }
 '正在启动工具箱并等待新版确认' | Add-Content -LiteralPath $Log -Encoding UTF8
 $launchedApp=Start-Process -FilePath $AppExe -ArgumentList '--updated' -WindowStyle Normal -PassThru
 $deadline=(Get-Date).AddSeconds(45)
 while (-not (Test-Path -LiteralPath $Healthy -PathType Leaf)) {
  if ($launchedApp.HasExited -or (Get-Date) -ge $deadline) { throw '工具箱未确认新版本已启动，请检查当前版本' }
  Start-Sleep -Milliseconds 250
 }
 '新版工具箱已启动' | Add-Content -LiteralPath $Log -Encoding UTF8
} catch {
 $reason=$_.Exception.Message
 try { $reason | Add-Content -LiteralPath $Log -Encoding UTF8 } catch { Write-Warning $reason }
 if ($oldAppExited -and -not $launchedApp -and (-not $installerProcess -or $installerProcess.HasExited)) {
  try { Start-Process -FilePath $AppExe -WindowStyle Normal } catch {}
 }
 if (Test-Path -LiteralPath $Ready) {
  try {
   Add-Type -AssemblyName System.Windows.Forms
   [void][System.Windows.Forms.MessageBox]::Show("$reason\`n日志：$Log", '钊叔工具箱更新未完成', 'OK', 'Warning')
  } catch {}
 }
 exit 1
}
`;}
async function waitForWindowsHelper(child,ready){
 const until=Date.now()+10000;
 while(child.exitCode===null&&child.signalCode===null&&Date.now()<until){
  if(await fs.access(ready).then(()=>true,()=>false))return;
  await delay(100);
 }
 if(child.exitCode===null&&child.signalCode===null)child.kill();
 throw Error('Windows 更新助手未就绪。请重试或查看更新目录中的 install-helper.log。');
}
async function launchHelper({platform,directory,file,info,mac,token,executable},spawnProcess=spawn){
 const log=path.join(directory,'install.log');let command,args,ready;
 if(platform==='darwin'){
  const helper=path.join(directory,'install.sh');await fs.writeFile(helper,macScript(),{mode:0o700});
  command='/bin/sh';args=[helper,String(process.pid),mac.target,mac.staged,mac.backup,path.join(directory,'healthy'),token,mac.binary];
 }else{
  const helper=path.join(directory,'install.ps1');await fs.writeFile(helper,'\ufeff'+windowsScript(),{mode:0o600});
  ready=path.join(directory,'helper-'+token+'.ready');
  command=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-ParentPid',String(process.pid),'-Installer',file,'-Digest',info.sha256,'-Log',log,'-Ready',ready,'-AppExe',executable,'-Healthy',path.join(directory,'healthy')];
 }
 const handle=await fs.open(ready?path.join(directory,'install-helper.log'):log,'a',0o600);
 try{
  const child=spawnProcess(command,args,{detached:true,windowsHide:true,stdio:['ignore',handle.fd,handle.fd]});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  if(ready)await waitForWindowsHelper(child,ready);
  child.unref();
 }finally{await handle.close();}
}
function createUpdater({app,manifestUrl,business,notify=()=>{},confirm=async()=>true,platform=process.platform,arch=process.arch,fetchRelease=fetchManifest,getNetworkRoute=async()=>null,downloader=downloadFile,prepare=prepareMac,launch=launchHelper}){
 let state={status:'idle',current:app.getVersion()},info=null,file=null,directory=null,operation=null,controller=null,canQuit=false;
 const root=path.join(app.getPath('userData'),'updates');
 const emit=patch=>{state={...state,...patch};notify({...state});return {...state};};
 const run=fn=>{if(operation)return operation;operation=fn().finally(()=>{operation=null;});return operation;};
 return {
  state:()=>({...state}),canQuit:()=>canQuit,isInstalling:()=>state.status==='installing',
  check(){if(operation||state.status==='downloaded'||state.status==='installing')return operation||Promise.resolve({...state});return run(async()=>{
   emit({status:'checking',message:'正在检查更新…'});
   try{info=validateAsset(await fetchRelease(manifestUrl),app.getVersion(),platform,arch);return emit({...info,message:''});}
   catch(e){info=null;return emit({status:'error',message:e.message});}
  });},
  download(){if(operation)return operation;if(state.status==='downloaded')return Promise.resolve({...state});return run(async()=>{
   if(!info||info.status!=='available')throw Error('请先检查更新');
   controller=new AbortController();emit({status:'downloading',percent:0,bytes:0,total:info.size,network:null,message:'正在下载更新…'});
   try{
    emit({network:await getNetworkRoute(info.download)});
    directory=path.join(root,info.latest+'-'+platform+'-'+arch);await fs.mkdir(directory,{recursive:true,mode:0o700});
    file=path.join(directory,platform==='darwin'?'installer.dmg':'installer.exe');
    let cached=false;try{await verifyFile(file,info);cached=true;}catch{}
    if(!cached)await downloader(info,file,{signal:controller.signal,onProgress:(bytes,total)=>emit({percent:Math.floor(bytes/total*100),bytes,total})});
    return emit({status:'downloaded',percent:100,message:'下载并校验完成。请保存当前工作，然后点击「重启更新」。'});
   }catch(e){return emit({status:'available',message:controller.signal.aborted?'下载已取消，可重新下载。':e.message,percent:0});}
   finally{controller=null;}
  });},
  cancel(){controller?.abort();},
  install(){if(operation)return operation;return run(async()=>{
   if(state.status!=='downloaded'||!file)throw Error('请先下载更新');
   if(!app.isPackaged)throw Error('请在已安装的工具箱中执行更新');
   if(business.isBusy())throw Error('任务正在执行，请完成后再重启更新');
   if(!await confirm())return {...state};
   // Reserve the business gate before any asynchronous preparation or quit.
   business.beginUpdate();emit({status:'installing',message:'正在准备更新，请稍候…'});
   let mac;
   try{
    await verifyFile(file,info);
    const token=crypto.randomBytes(16).toString('hex');
    const executable=app.getPath('exe');
    await fs.rm(path.join(directory,'healthy'),{force:true});await fs.rm(path.join(directory,'healthy.failed'),{force:true});
    if(platform==='darwin')mac=await prepare({file,directory,version:info.latest,executable,token});
    else if(platform!=='win32')throw Error('当前系统暂不支持自动安装');
    emit({message:'正在保存本机登录状态…'});
    await business.flushLogin();
    await fs.writeFile(path.join(root,'pending.json'),JSON.stringify({version:info.latest,directory,token}),{mode:0o600});
    if(platform==='win32')emit({message:'工具箱即将关闭，后台更新完成后会自动打开…'});
    await launch({platform,directory,file,info,mac,token,executable});
    canQuit=true;app.quit();return {...state};
   }catch(e){if(mac)await fs.rm(mac.staged,{recursive:true,force:true});business.endUpdate();emit({status:'downloaded',message:'更新未启动：'+e.message});throw e;}
  });},
 };
}
async function acknowledgeUpdate(app){
 const root=path.join(app.getPath('userData'),'updates'),pending=path.join(root,'pending.json');
 try{
  const value=JSON.parse(await fs.readFile(pending,'utf8'));
  if(value.version!==app.getVersion()||!/^\w{32}$/.test(value.token)||path.dirname(value.directory)!==root)return;
  if(process.platform==='darwin'&&!process.argv.includes('--toolkit-update-token='+value.token))return;
  await fs.writeFile(path.join(value.directory,'healthy'),'ok',{mode:0o600});await fs.rm(pending,{force:true});
 }catch{}
}
module.exports={validateAsset,allowedURL,downloadFile,verifyFile,prepareMac,macScript,windowsScript,launchHelper,createUpdater,acknowledgeUpdate};
