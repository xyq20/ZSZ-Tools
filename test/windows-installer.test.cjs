const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const fsp=require('node:fs/promises'),os=require('node:os'),{EventEmitter}=require('node:events');
const {windowsScript,launchHelper}=require('../business/app-update.cjs');
const powershell=process.platform==='win32'?'powershell.exe':process.env.TOOLKIT_TEST_PWSH;
test('Windows cleanup executes its real PowerShell selection rules',{skip:!powershell},()=>{
 const output=execFileSync(powershell,['-NoProfile','-NonInteractive','-File',path.join(__dirname,'windows-process-cleanup.ps1')],{encoding:'utf8'});assert.match(output,/PASS:/);
});
test('manual and automatic Windows installs use pre-uninstall cleanup',()=>{
 const pkg=require('../package.json'),hook=fs.readFileSync(path.join(__dirname,'../',pkg.build.nsis.include),'utf8');
 assert.match(hook,/!macro customCheckAppRunning/);assert.match(hook,/stop-toolkit-processes\.ps1/);assert.match(hook,/SetErrorLevel 2/);
 const update=windowsScript();
 assert.match(update,/WaitForExit\(15000\)/);
 assert.match(update,/Start-Process -FilePath \$Installer -ArgumentList @\('\/S','--updated'\) -PassThru/);
 assert.match(update,/\$installerProcess\.WaitForExit\(300000\)/);
 assert.match(update,/\$installerProcess\.ExitCode -ne 0[\s\S]*Start-Process -FilePath \$AppExe -ArgumentList '--updated'/);
 assert.match(update,/Test-Path -LiteralPath \$Healthy -PathType Leaf/);
 assert.match(update,/MessageBox\]::Show/);
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
  const command=launchHelper({platform:'win32',directory,file:path.join(directory,'installer.exe'),info:{sha256:'abc'},token,executable},(_command,args)=>{
   const ready=args[args.indexOf('-Ready')+1];
   assert.equal(ready,path.join(directory,`helper-${token}.ready`));
   assert.equal(args[args.indexOf('-AppExe')+1],executable);
   assert.equal(args[args.indexOf('-Healthy')+1],path.join(directory,'healthy'));
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
