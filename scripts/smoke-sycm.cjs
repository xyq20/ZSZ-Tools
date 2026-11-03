const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawn,execFileSync}=require('node:child_process'),ExcelJS=require('exceljs');
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'toolkit-sycm-ui-')),project=path.resolve(__dirname,'..'),file=path.join(dir,'sample.xlsx');
 const wb=new ExcelJS.Workbook(),sheet=wb.addWorksheet('总表');
 sheet.addRow(['商品名称','货号','访客','支付转化率','手淘推荐访客','手淘推荐支付转化率','手淘搜索访客','手淘搜索支付转化率','效果广告访客','效果广告支付转化率','内容广告访客','内容广告支付转化率','主图分析']);
 sheet.addRow(['测试商品','TEST','','',123]);sheet.getCell('A2').fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFF8392'}};await wb.xlsx.writeFile(file);
 const taskDir=path.join(dir,'profile/sycm/runs/run-fixture');await fs.mkdir(taskDir,{recursive:true});await fs.copyFile(file,path.join(taskDir,'sample.xlsx'));
 const options={mode:'flow'};await fs.writeFile(path.join(dir,'profile/sycm/last-task.json'),JSON.stringify({directory:taskDir,args:[],options}));
 const py=`import sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from excel_patch import list_catalog
from sycm_round import prepare_round,checkpoint
from sycm_collect import recent7_range,recent30_range
p=Path(sys.argv[2]); book=p/'sample.xlsx'; products=list_catalog(book)
r=p/'output/sycm/round_flow.json'
state,_=prepare_round(r,book,book,products,'flow',[*recent7_range(),*recent30_range()])
checkpoint(r,state,book,products)
`;
 execFileSync(path.join(project,'runtimes/mac-arm64/bin/python3.12'),['-c',py,path.join(project,'business/sycm-python'),taskDir],{env:{...process.env,SYCM_DATA_DIR:taskDir}});
 const script=`const {app,BrowserWindow,dialog,ipcMain}=require('electron'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
 const project=${JSON.stringify(project)},dir=${JSON.stringify(dir)},file=${JSON.stringify(file)};
 app.setPath('userData',path.join(dir,'profile'));let win;
 app.whenReady().then(async()=>{try{
  const original=fs.readFileSync(file);dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});ipcMain.handle('app-version',()=> 'test');
  win=new BrowserWindow({show:false,width:1280,height:960,webPreferences:{preload:path.join(project,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  const business=require(path.join(project,'business/desktop.cjs')).setupBusiness(win,app);await win.loadFile(path.join(project,'app/index.html'));
  const evaluate=s=>win.webContents.executeJavaScript(s,true);
  const wait=async s=>{for(let i=0;i<300;i++){if(await evaluate(s))return;await new Promise(r=>setTimeout(r,100));}throw Error('UI timed out: '+await evaluate("document.getElementById('sycm-progress').textContent"));};
  await evaluate("document.querySelector('aside [data-view=sycm]').click()");
  assert.equal(await evaluate("document.getElementById('sycm-start').disabled"),true);
  await evaluate("document.getElementById('sycm-choose').click()");await wait("!document.getElementById('sycm-start').disabled");
  await evaluate("document.getElementById('sycm-resume').click()");
  await wait("document.getElementById('sycm-progress').textContent.includes('本次处理完成')");
  assert.equal(await evaluate("document.getElementById('sycm-progress').textContent.includes('跳过 1')"),true);
  assert.deepEqual(fs.readFileSync(file),original);
  fs.writeFileSync(path.join(dir,'sycm.png'),(await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({ok:true,realPython:true,offlineVerifiedRoundResumed:true,screenshot:path.join(dir,'sycm.png')}));await business.flushLogin();win.destroy();app.exit(0);
 }catch(e){console.error(e.stack);if(win)win.destroy();app.exit(1);}});`;
 const entry=path.join(dir,'smoke.cjs');await fs.writeFile(entry,script);const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(require('electron'),[entry],{cwd:project,env,stdio:'inherit'});const code=await new Promise((r,j)=>{child.on('exit',r);child.on('error',j);});if(code)throw Error('生意参谋桌面验证失败');
})().catch(e=>{console.error(e);process.exitCode=1;});
