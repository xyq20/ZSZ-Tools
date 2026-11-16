const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {windowsScript}=require('../business/app-update.cjs');
const powershell=process.platform==='win32'?'powershell.exe':process.env.TOOLKIT_TEST_PWSH;
test('Windows cleanup executes its real PowerShell selection rules',{skip:!powershell},()=>{
 const output=execFileSync(powershell,['-NoProfile','-NonInteractive','-File',path.join(__dirname,'windows-process-cleanup.ps1')],{encoding:'utf8'});assert.match(output,/PASS:/);
});
test('manual and automatic Windows installs use pre-uninstall cleanup',()=>{
 const pkg=require('../package.json'),hook=fs.readFileSync(path.join(__dirname,'../',pkg.build.nsis.include),'utf8');
 assert.match(hook,/!macro customCheckAppRunning/);assert.match(hook,/stop-toolkit-processes\.ps1/);assert.match(hook,/SetErrorLevel 2/);
 assert.match(windowsScript(),/WaitForExit\(15000\)/);assert.match(windowsScript(),/'\/S','--updated','--force-run'/);
 const script=fs.readFileSync(path.join(__dirname,'../build/stop-toolkit-processes.ps1'),'utf8');assert(script.startsWith('\ufeff'));
});
