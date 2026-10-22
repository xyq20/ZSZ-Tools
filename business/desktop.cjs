const {BrowserWindow,ipcMain,dialog,session,safeStorage}=require('electron');const path=require('node:path');const ExcelJS=require('exceljs');
const prices=require('./prices.cjs');const reports=require('./reports.cjs');
const {createLoginState}=require('./login-state.cjs');
const {centerWorkbook}=require('./workbook-style.cjs');
const {createMonthlyTool}=require('./monthly.cjs');
function setupBusiness(win,app){
 let selected=null,priceResult=null,reportResult=null,busy=false;const loginWindows=new Map();
 const origins={price:'https://vipscm.superboss.cc',report:'https://viperp.superboss.cc',monthly:'https://erpa.superboss.cc'};
 const sessions={price:session.fromPartition('persist:toolkit-scm'),report:session.fromPartition('persist:toolkit-erp')};
 sessions.monthly=sessions.report;
 const progress=(tool,message)=>{if(!win.isDestroyed())win.webContents.send('business-progress',{tool,message});};
 const loginState=createLoginState({directory:path.join(app.getPath('userData'),'login-state'),sessions:{price:sessions.price,report:sessions.report},encryption:safeStorage,onError:message=>{progress('price',message);progress('report',message);progress('monthly',message);}});
 const loginReady=loginState.restore();
 async function request(tool,route,body){
  await loginReady;
  await new Promise(r=>setTimeout(r,tool==='price'?150:1800));
  const origin=origins[tool],form=tool==='monthly';
  const headers={'Content-Type':form?'application/x-www-form-urlencoded':'application/json','Origin':origin,'Referer':origin+'/'};
  if(form)Object.assign(headers,{Companyid:'111873','Module-Path':'/report/sale_multidimension_next/',Trackid:`trackid${Date.now()}_toolkit`});
  const response=await sessions[tool].fetch(origin+route,{credentials:'include',method:body?'POST':'GET',headers,body:body?(form?new URLSearchParams(body).toString():JSON.stringify(body)):undefined,redirect:'error',signal:AbortSignal.timeout(form?120000:45000)});
  if(!response.ok)throw Error(`接口 HTTP ${response.status}，请确认登录和权限`);
  let payload;try{payload=await response.json();}catch{throw Error('未返回有效数据，请先登录对应快麦账号');}
  if(payload.result===901)throw Error('登录已过期，请重新登录后查询');
  if(payload.result!==1&&!(form&&payload.suc===true))throw Error('查询未成功：'+String(payload.message||payload.msg||'请检查账号权限').slice(0,160));
  return payload;
 }
 function handle(name,fn){ipcMain.handle(name,async(e,...args)=>{if(e.sender!==win.webContents)throw Error('非法调用来源');try{return {ok:true,data:await fn(...args)};}catch(error){return {ok:false,error:error.message};}});}
 async function exclusive(fn){if(busy)throw Error('已有任务正在执行，请等待完成');busy=true;try{return await fn();}finally{busy=false;}}
 handle('business-login',async tool=>{
  await loginReady;
  if(!origins[tool])throw Error('未知工具');if(loginWindows.has(tool)){loginWindows.get(tool).focus();return;}
  const w=new BrowserWindow({title:tool==='price'?'登录快麦通':tool==='monthly'?'总表（双姐）· 登录快麦 ERP':'登录快麦 ERP',width:1100,height:780,parent:win,webPreferences:{session:sessions[tool],nodeIntegration:false,contextIsolation:true,sandbox:true}});loginWindows.set(tool,w);
  // Remote login has no preload or desktop IPC access.
  w.webContents.setWindowOpenHandler(({url})=>{try{if(new URL(url).protocol==='https:')w.loadURL(url).catch(()=>{});}catch{}return {action:'deny'};});
  w.webContents.on('will-navigate',(e,url)=>{if(!url.startsWith('https://'))e.preventDefault();});w.on('closed',()=>{loginWindows.delete(tool);loginState.flush();});
  await w.loadURL(origins[tool]+(tool==='price'?'/supplier/prod/center':tool==='monthly'?'/index.html':'/index.html#/report/dynamic/?reportId=67951')).catch(error=>{if(error.errno!==-3&&error.code!=='ERR_ABORTED')throw Error('登录页未能加载，请检查网络后重试');});return {message:'请在登录窗口完成登录，返回工具箱即可查询。'};
 });
 handle('business-choose',()=>exclusive(async()=>{const r=await dialog.showOpenDialog(win,{title:'选择 Excel 工作簿',buttonLabel:'打开',properties:['openFile'],filters:[{name:'Excel 工作簿',extensions:['xlsx']}]});if(r.canceled)return null;const book=await prices.readBook(r.filePaths[0]);selected=book;priceResult=null;const pending=book.rows.filter(prices.needsPrice).length;return {name:path.basename(book.file),sheet:book.sheet,rows:book.rows.length,pending,skipped:book.rows.length-pending};}));
 handle('business-price-query',()=>exclusive(async()=>{if(!selected)throw Error('请先选择工作簿');priceResult=null;const data=await prices.queryPrices(selected,(r,b)=>request('price',r,b),m=>progress('price',m));priceResult=data;return data;}));
 handle('business-price-save',()=>exclusive(async()=>{if(!priceResult)throw Error('请先完成价格查询');const n=priceResult.filter(r=>r.status==='待填入').length;if(!n)throw Error('没有待回填的价格');const confirm=await dialog.showMessageBox(win,{type:'question',buttons:['取消','备份并回填'],defaultId:0,cancelId:0,message:`确认填入 ${n} 行空白价格？`,detail:'仅填入价格列原本为空的单元格，已有内容、公式和异常行保留。原工作簿先备份。'});if(confirm.response!==1)return null;const result=await prices.writePrices(selected,priceResult);priceResult=null;selected=await prices.readBook(selected.file);return result;}));
 handle('business-price-export',()=>exclusive(async()=>{if(!priceResult)throw Error('请先查询价格');const r=await dialog.showSaveDialog(win,{title:'导出价格核对明细',buttonLabel:'保存',defaultPath:'价格核对明细.xlsx',filters:[{name:'Excel 工作簿',extensions:['xlsx']}]});if(r.canceled)return null;const wb=new ExcelJS.Workbook(),s=wb.addWorksheet('核对明细');s.addRow(['行号','货号','商品名称','原价格','淘宝 SKU 价格','状态','说明']);for(const x of priceResult)s.addRow([x.row,x.code,x.name,x.original,x.price,x.status,x.reason]);s.columns.forEach(c=>c.width=25);centerWorkbook(wb);await wb.xlsx.writeFile(r.filePath);return r.filePath;}));
 handle('business-report-query',(start,end)=>exclusive(async()=>{reportResult=null;reportResult=await reports.queryReport(start,end,(r,b)=>request('report',r,b),m=>progress('report',m));return reportResult;}));
 handle('business-report-export',()=>exclusive(async()=>{if(!reportResult)throw Error('请先查询报表');const r=await dialog.showSaveDialog(win,{title:'导出丹姐表格',buttonLabel:'保存',defaultPath:`丹姐表格_${reportResult.start}_${reportResult.end}.xlsx`,filters:[{name:'Excel 工作簿',extensions:['xlsx']}]});if(r.canceled)return null;await reports.exportReport(reportResult,r.filePath);return r.filePath;}));
 const monthly=createMonthlyTool({app,win,dialog,shell:require('electron').shell,request:(route,body)=>request('monthly',route,body),progress:message=>progress('monthly',message)});
 for(const [action,method] of [['monthly-choose','choose'],['monthly-plan','plan'],['monthly-preview','preview'],['monthly-save','save'],['monthly-export','export'],['monthly-reports','openReports']])handle('business-'+action,(...args)=>exclusive(()=>monthly[method](...args)));
 win.on('close',e=>{if(busy){e.preventDefault();dialog.showMessageBox(win,{message:'任务正在执行，请完成后再关闭工具箱。'});}});
 return {flushLogin:async()=>{await loginReady;await loginState.flush();await monthly.cleanup();},isBusy:()=>busy};
}
module.exports={setupBusiness};
