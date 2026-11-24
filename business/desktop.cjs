const {BrowserWindow,ipcMain,dialog,session,safeStorage}=require('electron');const path=require('node:path');const ExcelJS=require('exceljs');
const prices=require('./prices.cjs');const reports=require('./reports.cjs');
const {createLoginState}=require('./login-state.cjs');
const {centerWorkbook}=require('./workbook-style.cjs');
const {createMonthlyTool}=require('./monthly.cjs');
const {requestInErpPage,validatePayload}=require('./erp-page.cjs');
const {restoreWindow,bindLoginWindow}=require('./windows.cjs');
const {AsyncLocalStorage}=require('node:async_hooks');
const {toolOf,createRedactor,createActivity,createDiagnostics,registerReadOnly}=require('./diagnostics.cjs');
function setupBusiness(win,app){
 let selected=null,priceResult=null,reportResult=null,busy=false,updateLocked=false;const loginWindows=new Map();
 const origins={price:'https://vipscm.superboss.cc',report:'https://viperp.superboss.cc',monthly:'https://erpa.superboss.cc'};
 const sessions={price:session.fromPartition('persist:toolkit-scm'),report:session.fromPartition('persist:toolkit-erp')};
 sessions.monthly=sessions.report;
 const progress=(tool,message,batch)=>{if(!win.isDestroyed())win.webContents.send('business-progress',{tool,message,batch});};
 const requestContext=new AsyncLocalStorage();
 const redact=createRedactor({home:app.getPath('home')});
 const activity=createActivity({directory:path.join(app.getPath('userData'),'logs'),redact});
 let running=null;
 function reportRunning(value){
  running=value;
  if(!win.isDestroyed())win.webContents.send('business-busy',running);
 }
 const loginState=createLoginState({directory:path.join(app.getPath('userData'),'login-state'),sessions:{price:sessions.price,report:sessions.report},encryption:safeStorage,onError:message=>{progress('price',message);progress('report',message);progress('monthly',message);}});
 // The overview and updater do not need ERP credentials. Opening them must
 // not wait for a macOS Keychain prompt before the main window is ready.
 let loginReady = process.platform === 'darwin' ? null : loginState.restore();
 function ensureLoginReady() {
  return loginReady ??= loginState.restore();
 }
 async function request(tool,route,body){
  await ensureLoginReady();
  await new Promise(r=>setTimeout(r,tool==='price'?150:tool==='monthly'?1800:0));
  if(tool==='monthly'||tool==='report')return requestInErpPage(await loginWindow(tool,false),route,body);
  const origin=origins[tool];
  const headers={'Content-Type':'application/json','Origin':origin,'Referer':origin+'/'};
  const response=await sessions[tool].fetch(origin+route,{credentials:'include',method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(45000)});
  if(!response.ok)throw Error(`接口 HTTP ${response.status}，请确认登录和权限`);
  let payload;try{payload=await response.json();}catch{throw Error('未返回有效数据，请先登录对应快麦账号');}
  return validatePayload(payload);
 }
 function handle(name,fn){
  const action=name.slice('business-'.length);
  ipcMain.handle(name,async(event,...args)=>{
   if(event.sender!==win.webContents)throw Error('非法调用来源');
   const tool=action==='login'&&Object.hasOwn(origins,args[0])?args[0]:toolOf(action);
   const started=Date.now();
   try{
    if(updateLocked)throw Error('正在准备重启更新，请稍候');
    const data=await requestContext.run({action,tool},()=>fn(...args));
    activity.record({action,tool,ok:true,ms:Date.now()-started});
    return {ok:true,data};
   }catch(error){
    activity.record({action,tool,ok:false,ms:Date.now()-started,error:error.message});
    return {ok:false,error:error.message};
   }
  });
 }
 async function exclusive(fn,context=requestContext.getStore()){
  if(busy)throw Error('已有任务正在执行，请等待完成');
  busy=true;
  reportRunning({...context,since:Date.now()});
  try{return await fn();}
  finally{busy=false;reportRunning(null);}
 }
 async function runReminder(fn){
  const context={tool:'taobao-reminders',action:'taobao-reminders-scheduled'};
  try{return await exclusive(fn,context);}
  catch(error){activity.record({...context,ok:false,error:error.message});throw error;}
 }
 async function loginWindow(tool,show=true){
  await ensureLoginReady();
  if(!origins[tool])throw Error('未知工具');if(loginWindows.has(tool)){const existing=loginWindows.get(tool);if(show)restoreWindow(existing);return existing;}
  const w=new BrowserWindow({title:tool==='price'?'登录快麦通':tool==='monthly'?'总表（双姐）· 登录快麦 ERP':'登录快麦 ERP',width:1100,height:780,show,webPreferences:{backgroundThrottling:false,session:sessions[tool],nodeIntegration:false,contextIsolation:true,sandbox:true}});loginWindows.set(tool,w);bindLoginWindow(w,win);
  // Remote login has no preload or desktop IPC access.
  w.webContents.setWindowOpenHandler(({url})=>{try{if(new URL(url).protocol==='https:')w.loadURL(url).catch(()=>{});}catch{}return {action:'deny'};});
  w.webContents.on('will-navigate',(e,url)=>{if(!url.startsWith('https://'))e.preventDefault();});w.on('closed',()=>{loginWindows.delete(tool);loginState.flush();});
  await w.loadURL(origins[tool]+(tool==='price'?'/supplier/prod/center':tool==='monthly'?'/index.html':'/index.html#/report/dynamic/?reportId=67951')).catch(error=>{if(error.errno!==-3&&error.code!=='ERR_ABORTED')throw Error('登录页未能加载，请检查网络后重试');});return w;
 }
 handle('business-login',async tool=>{await loginWindow(tool);return {message:'请在登录窗口完成登录，返回工具箱即可查询；可以最小化或关闭登录窗口。'};});
 win.on('closed',()=>{for(const w of loginWindows.values())if(!w.isDestroyed())w.destroy();});
 handle('business-choose',()=>exclusive(async()=>{const r=await dialog.showOpenDialog(win,{title:'选择 Excel 工作簿',buttonLabel:'打开',properties:['openFile'],filters:[{name:'Excel 工作簿',extensions:['xlsx']}]});if(r.canceled)return null;const book=await prices.readBook(r.filePaths[0]);selected=book;priceResult=null;const pending=book.rows.filter(prices.needsPrice).length;return {name:path.basename(book.file),sheet:book.sheet,rows:book.rows.length,pending,skipped:book.rows.length-pending};}));
 handle('business-price-query',()=>exclusive(async()=>{if(!selected)throw Error('请先选择工作簿');priceResult=null;const data=await prices.queryPrices(selected,(r,b)=>request('price',r,b),m=>progress('price',m));priceResult=data;return data;}));
 handle('business-price-save',()=>exclusive(async()=>{if(!priceResult)throw Error('请先完成价格查询');const n=priceResult.filter(r=>r.status==='待填入').length;if(!n)throw Error('没有待回填的价格');const confirm=await dialog.showMessageBox(win,{type:'question',buttons:['取消','备份并回填'],defaultId:0,cancelId:0,message:`确认填入 ${n} 行空白价格？`,detail:'仅填入价格列原本为空的单元格，已有内容、公式和异常行保留。原工作簿先备份。'});if(confirm.response!==1)return null;const result=await prices.writePrices(selected,priceResult);priceResult=null;selected=await prices.readBook(selected.file);return result;}));
 handle('business-price-export',()=>exclusive(async()=>{if(!priceResult)throw Error('请先查询价格');const r=await dialog.showSaveDialog(win,{title:'导出价格核对明细',buttonLabel:'保存',defaultPath:'价格核对明细.xlsx',filters:[{name:'Excel 工作簿',extensions:['xlsx']}]});if(r.canceled)return null;const wb=new ExcelJS.Workbook(),s=wb.addWorksheet('核对明细');s.addRow(['行号','货号','商品名称','原价格','淘宝 SKU 价格','状态','说明']);for(const x of priceResult)s.addRow([x.row,x.code,x.name,x.original,x.price,x.status,x.reason]);s.columns.forEach(c=>c.width=25);centerWorkbook(wb);await wb.xlsx.writeFile(r.filePath);return r.filePath;}));
 handle('business-report-query',(start,end)=>exclusive(async()=>{reportResult=null;reportResult=await reports.queryReport(start,end,(r,b)=>request('report',r,b),m=>progress('report',m));return reportResult;}));
 handle('business-report-export',()=>exclusive(async()=>{if(!reportResult)throw Error('请先查询报表');const r=await dialog.showSaveDialog(win,{title:'导出丹姐表格',buttonLabel:'保存',defaultPath:`丹姐表格_${reportResult.start}_${reportResult.end}.xlsx`,filters:[{name:'Excel 工作簿',extensions:['xlsx']}]});if(r.canceled)return null;await reports.exportReport(reportResult,r.filePath);return r.filePath;}));
 const monthly=createMonthlyTool({app,win,dialog,shell:require('electron').shell,request:(route,body)=>request('monthly',route,body),progress:message=>progress('monthly',message)});
 for(const [action,method] of [['monthly-choose','choose'],['monthly-plan','plan'],['monthly-preview','preview'],['monthly-save','save'],['monthly-export','export'],['monthly-reports','openReports']])handle('business-'+action,(...args)=>exclusive(()=>monthly[method](...args)));

 const returnRate=require('./return-rate.cjs').createReturnRateTool({
  app,win,dialog,shell:require('electron').shell,safeStorage,
  progress:(message,step)=>progress('return-rate',message,step)
 });
 handle('business-return-rate-status', returnRate.status);
 for(const [action,method] of [['import','importConfig'],['start','start'],['reveal','reveal']])
  handle('business-return-rate-'+action,(...args)=>exclusive(()=>returnRate[method](...args)));
 const erpStockRules=require('./erp-stock-rules.cjs').createErpStockRulesTool({
  app,win,dialog,shell:require('electron').shell,
  getCookies:async url=>{await ensureLoginReady();return sessions.monthly.cookies.get({url});},
  progress:message=>progress('erp-stock-rules',message),
  notifySchedule:schedule=>progress('erp-stock-rules',schedule.message||'',{schedule})
 });
 for(const [action,method] of [['list','list'],['preview','preview'],['upload','upload'],['reveal','reveal'],
  ['schedule-save','saveSchedule'],['schedule-interval','updateScheduleInterval']])
  handle('business-erp-stock-rules-'+action,(...args)=>exclusive(()=>erpStockRules[method](...args)));
 handle('business-erp-stock-rules-schedule-cancel',erpStockRules.cancelSchedule);
 registerReadOnly({ipcMain,win,redact},'business-erp-stock-rules-schedule-status',erpStockRules.scheduleStatus);
 const stockScheduleContext={tool:'erp-stock-rules',action:'erp-stock-rules-scheduled'};
 const stockScheduleTimer=setInterval(()=>{
  if(busy||updateLocked||!erpStockRules.scheduleDue())return;
  void exclusive(erpStockRules.runScheduled,stockScheduleContext).catch(error=>{
   activity.record({...stockScheduleContext,ok:false,error:error.message});
   progress('erp-stock-rules','定时记录无法保存，上传已停止。');
  });
 },1000);
 stockScheduleTimer.unref();
 win.once('closed',()=>clearInterval(stockScheduleTimer));
 const taobao=require('./taobao.cjs').createTaobaoTool({app,win,dialog,safeStorage,progress:message=>progress('taobao',message)});
 for(const [action,method] of [['taobao-settings','settings'],['taobao-save-key','saveKey'],['taobao-login','login'],['taobao-choose','choose'],['taobao-prepare','prepare'],['taobao-publish','publish'],['taobao-history','history']])handle('business-'+action,(...args)=>exclusive(()=>taobao[method](...args)));
 const reminders=require('./taobao-reminders.cjs').createTaobaoReminders({
  app,safeStorage,exclusive:runReminder,blocked:()=>busy||updateLocked,progress:message=>progress('taobao-reminders',message)
 });
 handle('business-taobao-reminders-status',reminders.status);
 for(const method of ['save','login','preview'])handle('business-taobao-reminders-'+method,(...args)=>exclusive(()=>reminders[method](...args)));
 handle('business-taobao-reminders-run-now',()=>exclusive(reminders.runNow));
 const stock=require('./taobao-stock.cjs').createTaobaoStockTool({app,win,dialog,shell:require('electron').shell,progress:message=>progress('taobao-stock',message)});
 for(const [action,method] of [['login','login'],['verify-login','verifyLogin'],['choose','choose'],['start','start'],['resume','resume'],['report','openReport']])handle('business-taobao-stock-'+action,(...args)=>exclusive(()=>stock[method](...args)));
 const soutu=require('./taobao-soutu.cjs').createTaobaoSoutuTool({
  app,win,dialog,shell:require('electron').shell,getModelKey:taobao.getModelKey,
  fetchModel:(url,options)=>session.defaultSession.fetch(url,options),
  progress:(message,batch)=>progress('taobao-soutu',message,batch)
 });
 for(const [action,method] of [['login','login'],['choose','choose'],['scan','scan'],['plan','plan'],['publish','publish'],['history','history'],['resolve','resolvePending'],['archive','openArchive']])handle('business-taobao-soutu-'+action,(...args)=>exclusive(()=>soutu[method](...args)));
 const sycm=require('./sycm.cjs').createSycmTool({app,win,dialog,shell:require('electron').shell,progress:message=>progress('sycm',message)});
 for(const method of ['choose','login','start','resume','results'])handle('business-sycm-'+method,(...args)=>exclusive(()=>sycm[method](...args)));
 const diagnostics=createDiagnostics({app,safeStorage,sessions,ensureLoginReady,reminders,getRunning:()=>running,activity,redact});
 registerReadOnly({ipcMain,win,redact},'business-ops-snapshot',diagnostics.snapshot);
 registerReadOnly({ipcMain,win,redact},'business-task-state',()=>running);
 win.on('close',e=>{if(busy){e.preventDefault();dialog.showMessageBox(win,{message:'任务正在执行，请完成后再关闭工具箱。'});}});
 return {beginUpdate:()=>{if(busy||updateLocked)throw Error('任务正在执行，请完成后再更新');updateLocked=true;},endUpdate:()=>{updateLocked=false;},flushLogin:async({keepSchedule=false}={})=>{if(!keepSchedule)reminders.stop();if(loginReady){await loginReady;await loginState.flush();}await monthly.cleanup();await taobao.cleanup();await stock.cleanup();await soutu.cleanup();await activity.flush();},isBusy:()=>busy};
}
module.exports={setupBusiness};
