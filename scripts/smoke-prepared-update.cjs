// Exercise the shipping UI, updater, extracted payload and relaunched window on a fresh OS runner.
// Only the draft-release transport is substituted in the disposable starting process.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const net=require('node:net');
const os=require('node:os');
const path=require('node:path');
const {spawn,execFile}=require('node:child_process');
const exec=require('node:util').promisify(execFile);
const {setTimeout:delay}=require('node:timers/promises');
const {chromium}=require('playwright-core');
const {verifyFile}=require('../business/windows-update.cjs');
const {manifestUrl}=require('../update-config.json');
const version=require('../package.json').version;
const win=process.platform==='win32';
const fixture=process.env.RUNNER_TEMP;
const data=path.join(win?(process.env.APPDATA||''):path.join(os.homedir(),'Library','Application Support'),'team-toolkit');
const directory=path.join(data,'updates',version+'-'+process.platform+'-'+process.arch);
const assetUrl=name=>'https://github.com/xyq20/ZSZ-Tools/releases/download/v'+version+'/'+name;
const ps=command=>exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{timeout:25000});
async function until(description,read,timeout=45000){
 const end=Date.now()+timeout;
 while(Date.now()<end){const value=await read();if(value)return value;await delay(70);}
 throw Error('Timed out waiting for '+description);
}
async function port(){
 const socket=net.createServer();await new Promise((resolve,reject)=>socket.once('error',reject).listen(0,'127.0.0.1',resolve));
 const value=socket.address().port;await new Promise(resolve=>socket.close(resolve));return value;
}
async function pageAt(portNumber){
 const url='http://127.0.0.1:'+portNumber;
 await until('desktop debugging socket',()=>fetch(url+'/json/version').then(r=>r.ok,()=>false));
 const browser=await chromium.connectOverCDP(url);
 const context=browser.contexts()[0];
 const page=context.pages()[0]||await context.waitForEvent('page');
 try{await page.locator('#app-version').filter({hasText:/v\d/}).waitFor();}
 catch(error){console.error('Desktop page',page.url(),(await page.locator('body').innerText({timeout:1000}).catch(()=>'' )).slice(0,600));await browser.close().catch(()=>{});throw error;}
 return {browser,page};
}
async function inMain(portNumber,expression){
 const list=await until('local main-process inspector',async()=>{
  try{return (await (await fetch('http://127.0.0.1:'+portNumber+'/json/list')).json())[0];}catch{return null;}
 });
 const socket=new WebSocket(list.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 const messages=new Map();
 let id=0;
 socket.onmessage=event=>{
  const result=JSON.parse(event.data),ready=messages.get(result.id);
  if(ready){messages.delete(result.id);ready(result);}
 };
 const send=(method,params={})=>new Promise((resolve,reject)=>{
  const request=++id,timer=setTimeout(()=>reject(Error('Inspector timeout: '+method)),12000);
  messages.set(request,answer=>{clearTimeout(timer);resolve(answer);});
  socket.send(JSON.stringify({id:request,method,params}));
 });
 try{
  const answer=await send('Runtime.evaluate',{expression,returnByValue:true});
  if(answer.error||answer.result?.exceptionDetails)throw Error(JSON.stringify(answer));
  return answer.result.result.value;
 }finally{await new Promise(resolve=>{socket.onclose=resolve;socket.close();});}
}
async function stageOffer(portNumber,offer,payloadURL,payload){
 const inject=(args)=>{
  const load=process.getBuiltinModule('node:module').createRequire(process.resourcesPath+'/app.asar/bootstrap.cjs');
  const session=load('electron').session.fromPartition('toolkit-updates');
  const {createReadStream}=load('node:fs'),{Readable}=load('node:stream');
  session.fetch=async url=>{
   if(url===args.manifest)return Response.json(args.offer);
   if(url===args.payloadURL)return new Response(Readable.toWeb(createReadStream(args.payload)));
   throw Error('Unexpected fixture request '+url);
  };
  return 'draft attached';
 };
 const expression='('+inject.toString()+')('+JSON.stringify({offer,payloadURL,payload,manifest:manifestUrl})+')';
 assert.equal(await inMain(portNumber,expression),'draft attached');
}
async function install(base,workspace){
 if(win){
  const install=path.join(workspace,'工具箱');
  await exec(base,['/S','/currentuser','/D='+install],{timeout:150000});
  return path.join(install,'钊叔工具箱.exe');
 }
 const bundle='钊叔工具箱.app',mount=path.join(workspace,'image');
 await fs.mkdir(mount);
 await exec('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,base]);
 try{await exec('/usr/bin/ditto',[path.join(mount,bundle),path.join(workspace,bundle)]);}
 finally{await exec('/usr/bin/hdiutil',['detach',mount]);}
 return path.join(workspace,bundle,'Contents/MacOS/钊叔工具箱');
}
async function osWindow(pid){
 assert(Number.isSafeInteger(pid)&&pid>0);
 if(win){
  const {stdout}=await ps(`
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ToolkitWindow { [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }'
$h=(Get-Process -Id ${pid}).MainWindowHandle
[pscustomobject]@{ visible=($h -ne [IntPtr]::Zero -and [ToolkitWindow]::IsWindowVisible($h) -and -not [ToolkitWindow]::IsIconic($h)); focused=([ToolkitWindow]::GetForegroundWindow() -eq $h) } | ConvertTo-Json -Compress`);
  return JSON.parse(stdout);
 }
 const {stdout}=await exec('/usr/bin/swift',['-e',`
import AppKit
import CoreGraphics
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String:Any]] ?? []
let visible = list.contains { ($0[kCGWindowOwnerPID as String] as? Int) == ${pid} && ($0[kCGWindowLayer as String] as? Int) == 0 }
let focused = NSWorkspace.shared.frontmostApplication?.processIdentifier == ${pid}
print("{\\"visible\\":\\(visible),\\"focused\\":\\(focused)}")
`],{timeout:90000});return JSON.parse(stdout);
}
async function closeWindow(pid){
 if(win)assert.equal((await ps('(Get-Process -Id '+pid+').CloseMainWindow()')).stdout.trim(),'True');
 else await exec('/usr/bin/swift',['-e','import AppKit; _ = NSRunningApplication(processIdentifier:'+pid+')?.terminate()']);
 await until('confirmed process exit',()=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}});
}
async function verify(){
 assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted','Requires a disposable runner');
 await assert.rejects(fs.access(data),{code:'ENOENT'});
 const release=JSON.parse((await fs.readFile(path.join(fixture,'hot-offer.json'),'utf8')).replace(/^\uFEFF/,''));
 assert.equal(release.isDraft,true);
 const suffix=win?'win-x64.exe':'mac-arm64.dmg',payloadSuffix=win?'win-x64.zip':suffix;
 const starting=release.assets.find(item=>item.name.startsWith('qa-start-')&&item.name.endsWith(suffix));
 const payloadAsset=release.assets.find(item=>item.name==='-'+version+'-'+payloadSuffix);
 const before=starting.name.match(/^qa-start-(\d+\.\d+\.\d+)-/)[1],base=path.join(fixture,'starting.'+suffix.split('.').pop());
 const payload=path.join(fixture,'offered.'+payloadSuffix.split('.').pop());
 for(const [item,file] of [[starting,base],[payloadAsset,payload]])await verifyFile(file,{size:item.size,sha256:item.digest.slice(7)});
 const offer={tag_name:'v'+version,body:'桌面端更新验收',assets:release.assets.filter(a=>a.name.startsWith('-'+version+'-')).map(a=>({...a,browser_download_url:assetUrl(a.name)}))};
 const workspace=await fs.mkdtemp(path.join(fixture,'update-'));
 const executable=await install(base,workspace);
 const rendererPort=await port(),mainPort=await port();
 const output=await fs.open(path.join(workspace,'app.log'),'a');
 let browser;
 try{
  const old=spawn(executable,['--remote-debugging-port='+rendererPort,'--inspect=127.0.0.1:'+mainPort],{stdio:['ignore',output.fd,output.fd]});
  old.unref();
  console.log('Starting packaged baseline',before,'PID',old.pid);
  const ui=await pageAt(rendererPort);browser=ui.browser;const page=ui.page;
  console.log('Baseline window available');
  page.on('pageerror',error=>console.error('Renderer:',error.message));
  assert((await page.locator('#app-version').innerText()).includes('v'+before));
  await stageOffer(mainPort,offer,assetUrl(payloadAsset.name),payload);
  await page.locator('#check-update').click();
  await page.locator('#download-update').click();
  console.log('Update download started');
  await page.locator('#update-status').filter({hasText:'后台准备'}).waitFor({timeout:180000});
  console.log('Application is preparing the payload');
  assert(await page.locator('#install-update').isHidden());
  await page.locator('#close-update').click();
  await page.locator('aside [data-view="report"]').click();assert(await page.locator('#report').isVisible());
  await page.locator('#check-update').click();
  await page.locator('#install-update').waitFor({timeout:240000});
  await fs.writeFile(path.join(data,'qa-preserve-setting'),'preserve');
  console.log('Update prepared');
  const clicked=Date.now();
  await page.locator('#install-update').click({noWaitAfter:true}).catch(error=>{if(!page.isClosed())throw error;});
  const proof=await until('new window receipt',async()=>{
   const failure=await fs.readFile(path.join(directory,'healthy.failed'),'utf8').catch(()=>null);if(failure)throw Error(failure);
   const contents=await fs.readFile(path.join(directory,'healthy'),'utf8').catch(()=>null);
   return contents&&JSON.parse(contents);
  },90000);
  assert.equal(proof.version,version);assert.equal(proof.interactive,true);assert.equal(proof.visible,true);
  assert(proof.pid!==old.pid&&proof.readyAt>=clicked&&proof.elapsedMs>=0);
  const observed=await osWindow(proof.pid);
  assert.equal(observed.visible,true,'OS did not report a visible restored window');
  assert.equal(await fs.readFile(path.join(data,'qa-preserve-setting'),'utf8'),'preserve');
  const result={system:process.platform,architecture:process.arch,version,clickToWindowMs:proof.elapsedMs,
   windowVisible:observed.visible,appFocused:proof.focused,osForeground:observed.focused};
  console.log('PREPARED_UPDATE_RESULT',JSON.stringify(result));
  await closeWindow(proof.pid);
  const nextPort=await port();
  const relaunched=spawn(executable,['--remote-debugging-port='+nextPort],{detached:true,stdio:'ignore'});relaunched.unref();
  const stable=await pageAt(nextPort);browser=stable.browser;
  assert((await stable.page.locator('#app-version').innerText()).includes('v'+version),'original application entry opened the previous version');
  await stable.page.locator('aside [data-view="price"]').click();assert(await stable.page.locator('#price').isVisible());
  console.log('Original desktop entry reopened the updated interactive application.');
 }catch(error){
  if(browser){const page=browser.contexts()[0]?.pages()[0];if(page)console.error('Update UI:',await page.locator('#update-status').textContent({timeout:1600}).catch(()=>''));}
  console.error('Update files:',await fs.readdir(directory).catch(()=>[]));
  for(const file of [path.join(workspace,'app.log'),path.join(data,'startup.log'),...['install.log','install-helper.log','healthy.failed'].map(name=>path.join(directory,name))]){
   console.error(path.basename(file),(await fs.readFile(file,'utf8').catch(()=>'' )).slice(-2200));
  }
  throw error;
 }finally{await output.close();if(browser)await Promise.race([browser.close().catch(()=>{}),delay(3000)]);}
}
verify().catch(error=>{console.error(error);process.exit(1);});
