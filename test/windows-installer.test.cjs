const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const fsp=require('node:fs/promises'),os=require('node:os'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const {setTimeout:delay}=require('node:timers/promises');
const {acknowledgeUpdate,launchHelper}=require('../business/app-update.cjs');
const powershell=process.platform==='win32'?'powershell.exe':process.env.TOOLKIT_TEST_PWSH;
test('Windows cleanup executes its real PowerShell selection rules',{skip:!powershell},()=>{
 const output=execFileSync(powershell,['-NoProfile','-NonInteractive','-File',path.join(__dirname,'windows-process-cleanup.ps1')],{encoding:'utf8'});assert.match(output,/PASS:/);
});
test('manual and automatic Windows installs use pre-uninstall cleanup',()=>{
 const pkg=require('../package.json'),hook=fs.readFileSync(path.join(__dirname,'../',pkg.build.nsis.include),'utf8');
 assert.match(hook,/!macro customCheckAppRunning/);assert.match(hook,/stop-toolkit-processes\.ps1/);assert.match(hook,/SetErrorLevel 2/);
 const script=fs.readFileSync(path.join(__dirname,'../build/stop-toolkit-processes.ps1'),'utf8');assert(script.startsWith('\ufeff'));
});
test('Windows updater hands off only after the installation helper signals readiness',async t=>{
 const directory=await fsp.mkdtemp(path.join(os.tmpdir(),'toolkit-win-helper-'));
 t.after(()=>fsp.rm(directory,{recursive:true,force:true}));
 for(const starts of [false,true]){
  const child=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null});
  let detached=false;
  child.unref=()=>{detached=true;};
  const token=starts?'successful':'failed';
  const executable=path.join(directory,'钊叔工具箱.exe');
  const command=launchHelper({platform:'win32',directory,file:path.join(directory,'installer.exe'),info:{sha256:'abc',size:1},token,executable,windowsNode:process.execPath},(command,args)=>{
   const request=JSON.parse(args[1]);
   assert.equal(command,path.join(directory,'update-node.exe'));
   assert.equal(request.executable,executable);
   assert.equal(request.token,token);
   const ready=path.join(request.directory,`helper-${token}.ready`);
   setImmediate(()=>{
    child.emit('spawn');
    if(starts)fs.writeFileSync(ready,'ready');
    else{child.exitCode=1;child.emit('exit',1);}
   });
   return child;
  });
  if(starts)await command;
  else await assert.rejects(command,/更新助手未就绪/);
  assert.equal(detached,starts);
 }
});

test('staged update helper waits for exit, runs silently and reopens the toolbox on success or failure',
 {skip:process.platform==='win32'},async t=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'toolkit-helper-流程-'));
 t.after(()=>fsp.rm(root,{recursive:true,force:true}));
 const updates=path.join(root,'updates');
 for(const exitCode of [0,2]){
  const directory=path.join(updates,String(exitCode));await fsp.mkdir(directory,{recursive:true});
  const file=path.join(directory,'installer.exe'),executable=path.join(directory,'toolbox.exe');
  const trace=path.join(directory,'trace'),healthy=path.join(directory,'healthy');
  const token='0'.repeat(32);
  const install='#!/bin/sh\nprintf "installer: %s\\n" "$*" >> "$TRACE"\nexit "$INSTALL_EXIT"\n';
  const reopen='#!/bin/sh\nprintf "toolbox: %s\\n" "$*" >> "$TRACE"\nif [ "$INSTALL_EXIT" = 0 ]; then printf ok > "$HEALTHY"; fi\n';
  await fsp.writeFile(file,install,{mode:0o700});await fsp.writeFile(executable,reopen,{mode:0o700});
  await fsp.writeFile(path.join(updates,'pending.json'),JSON.stringify({version:'0.4.32',directory,token}));
  const fixture={platform:'win32',directory,file,info:{sha256:crypto.createHash('sha256').update(install).digest('hex'),size:Buffer.byteLength(install)},token,executable,windowsNode:process.execPath};
  const driver=`require(${JSON.stringify(require.resolve('../business/app-update.cjs'))}).launchHelper(${JSON.stringify(fixture)}).catch(e=>{console.error(e);process.exitCode=1;})`;
  execFileSync(process.execPath,['-e',driver],{env:{...process.env,INSTALL_EXIT:String(exitCode),TRACE:trace,HEALTHY:healthy},timeout:12000});
  const logFile=path.join(directory,'install.log');
  for(let attempt=0;attempt<50;attempt++){
   const log=await fsp.readFile(logFile,'utf8');
   const observed=await fsp.readFile(trace,'utf8').catch(()=>'');
   if(observed.includes('toolbox: --updated')&&/新版工具箱已启动|安装器退出码 2/.test(log))break;
   await delay(100);
  }
  assert.equal(await fsp.readFile(trace,'utf8'),'installer: /S --updated\ntoolbox: --updated\n');
  const log=await fsp.readFile(logFile,'utf8');
  if(exitCode===0)assert.match(log,/新版工具箱已启动/);
  else{
   assert.match(log,/安装器退出码 2/);
   assert.deepEqual(await acknowledgeUpdate({getPath:()=>root,getVersion:()=> '0.4.30'},'win32'),{detail:'后台更新失败，安装器退出码 2',log:logFile});
  }
 }
});
