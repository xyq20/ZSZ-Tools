// Run the real desktop IPC and Python bridge with a temporary workbook,
// an isolated Electron profile, and deterministic ERP responses.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {fixture}=require('../test/helpers/monthly-fixture.cjs');
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'toolkit-monthly-ui-'));
 const sample=await fixture(directory),project=path.resolve(__dirname,'..');
 await fs.writeFile(path.join(directory,'rows.json'),JSON.stringify(sample.rows));
 const bootstrap=`
const {app,BrowserWindow,dialog,ipcMain,session}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const project=${JSON.stringify(project)},directory=${JSON.stringify(directory)},file=${JSON.stringify(sample.file)};
app.setPath('userData',path.join(directory,'profile'));app.commandLine.appendSwitch('lang','zh-CN');
let business,win;
app.whenReady().then(async()=>{
 try{
  const rows=JSON.parse(fs.readFileSync(path.join(directory,'rows.json'))),queries=[];
  session.fromPartition('persist:toolkit-erp').fetch=async(url,options)=>{const body=new URLSearchParams(options.body);queries.push(body.get('asTypes'));assert.equal(options.headers.Companyid,'111873');return {ok:true,json:async()=>({result:1,data:{list:rows}})};};
  dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});
  dialog.showMessageBox=async()=>({response:1});
  dialog.showSaveDialog=async()=>({canceled:false,filePath:path.join(directory,'核对.xlsx')});
  ipcMain.handle('app-version',()=>require(path.join(project,'package.json')).version);
  win=new BrowserWindow({show:false,width:1280,height:850,webPreferences:{preload:path.join(project,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  business=require(path.join(project,'business/desktop.cjs')).setupBusiness(win,app);
  await win.loadFile(path.join(project,'app/index.html'));
  const evaluate=expression=>win.webContents.executeJavaScript(expression,true);
  const wait=async expression=>{for(let i=0;i<400;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out waiting for UI: '+expression);};
  await evaluate(\"document.querySelector('aside [data-view=monthly]').click();document.getElementById('monthly-date').value='2026-10-22';document.getElementById('monthly-choose').click()\");
  await wait(\"document.getElementById('monthly-progress').textContent.includes('总表已读取')\");
  assert.equal(await evaluate(\"document.getElementById('crumb').textContent\"),'总表（双姐）');
  await evaluate(\"document.getElementById('monthly-preview').click()\");
  await wait(\"document.getElementById('monthly-progress').textContent.includes('预览完成')\");
  assert.equal(await evaluate(\"document.getElementById('monthly-save').disabled\"),false);
  assert.equal(await evaluate(\"document.querySelectorAll('#monthly-results tbody tr').length\"),rows.length);
  assert.deepEqual(queries,['','5','1,2,7,8,10','5,1,2,7,8,10']);
  fs.writeFileSync(path.join(directory,'preview.png'),(await win.webContents.capturePage()).toPNG());
  await evaluate(\"document.getElementById('monthly-export').click()\");
  await wait(\"document.getElementById('monthly-progress').textContent.includes('已导出核对明细')\");
  await evaluate(\"document.getElementById('monthly-save').click()\");
  await wait(\"document.getElementById('monthly-progress').textContent.includes('总表已更新')\");
  assert(fs.existsSync(path.join(directory,'26年10月分级总表.xlsx')));assert(fs.existsSync(path.join(directory,'26年10月分级总表.xlsx.bak')));
  console.log(JSON.stringify({ok:true,rows:rows.length,queries:queries.length,screenshot:path.join(directory,'preview.png'),directory}));
  await business.flushLogin();win.destroy();app.exit(0);
 }catch(error){console.error(error.stack);if(win)win.destroy();app.exit(1);}
});
`;
 const entry=path.join(directory,'desktop-smoke.cjs');await fs.writeFile(entry,bootstrap);
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(require('electron'),[entry],{cwd:project,env,stdio:'inherit'});
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
 if(code!==0)throw Error('Desktop monthly smoke test failed');
 console.log('Desktop smoke artifacts: '+directory);
})().catch(error=>{console.error(error.message);process.exitCode=1;});
