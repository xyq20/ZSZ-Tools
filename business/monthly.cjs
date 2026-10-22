const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const ExcelJS=require('exceljs');
const {centerWorkbook}=require('./workbook-style.cjs');

function runtimePaths(app){
 const root=app.isPackaged?process.resourcesPath:path.resolve(__dirname,'..');
 const runtime=app.isPackaged?path.join(root,'python'):path.join(root,'runtimes',`${process.platform==='darwin'?'mac':'win'}-${process.arch}`);
 return {python:process.platform==='win32'?path.join(runtime,'python.exe'):path.join(runtime,'bin/python3.12'),bridge:path.join(app.isPackaged?root:__dirname,'monthly-python/bridge.py')};
}
function runPython(paths,job,progress=()=>{}){
 return new Promise((resolve,reject)=>{
  const child=spawn(paths.python,['-I','-B','-X','utf8','-u',paths.bridge],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let pending='',bytes=0,stderr='',result,failed=false;
  const fail=error=>{if(failed)return;failed=true;clearTimeout(timer);child.kill();reject(error);};
  const timer=setTimeout(()=>fail(Error('总表处理超时，请关闭 Excel/WPS 后重试')),15*60*1000);
  child.on('error',error=>fail(Error(error.code==='ENOENT'?'总表运行环境缺失，请安装包含总表工具的完整新版':error.message)));
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
   bytes+=Buffer.byteLength(chunk);if(bytes>64*1024*1024)return fail(Error('总表结果过大，请缩小工作簿后重试'));
   pending+=chunk;let end;
   while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);if(!line.trim())continue;
    try{const message=JSON.parse(line);if(message.type==='progress')progress(String(message.data));else if(message.type==='result')result=message.data;}catch{return fail(Error('总表处理程序返回了无效结果'));}
   }
  });
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-16000);});
  child.on('close',code=>{clearTimeout(timer);if(failed)return;if(!result?.ok)return reject(Error(result?.error||stderr.trim()||`总表处理程序退出（${code}）`));if(code!==0)return reject(Error('总表处理未正常结束'));resolve(result.value);});
  child.stdin.on('error',error=>{if(error.code!=='EPIPE')fail(error);});
  child.stdin.end(JSON.stringify(job));
 });
}
function validateRunDate(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw Error('请选择有效的运行日期');return value;}
async function queryDataset(query,request,progress){
 const records=[];let first=null,expected=null;
 const size=Number(query.payload.pageSize);if(!Number.isInteger(size)||size<1)throw Error('总表分页参数无效');
 for(let page=1;page<=500;page++){
  progress(`正在查询${query.label}，第 ${page} 页…`);
  const response=await request('/report/sale/dimensions/list',{...query.payload,pageNo:String(page)});
  if(response.result!==1&&response.suc!==true)throw Error(`${query.label}查询未成功`);
  const batch=response.data?.list;if(!Array.isArray(batch)||batch.length>size)throw Error(`${query.label}分页数据无效`);
  const total=response.data?.total??response.data?.page?.totalCount;
  if(total!=null){const next=Number(total);if(!Number.isInteger(next)||next<0||expected!==null&&next!==expected)throw Error(`${query.label}分页数量变化，请重新查询`);expected=next;}
  if(!first)first=response;
  records.push(...batch);
  if(expected!==null&&records.length>expected)throw Error(`${query.label}分页数量异常`);
  progress(`${query.label}已读取 ${records.length} 条`);
  if(batch.length<size){if(expected!==null&&records.length!==expected)throw Error(`${query.label}分页不完整`);return {...first,data:{...first.data,list:records},syncMeta:{fetchedAt:new Date().toISOString(),pages:page,count:records.length,asTypes:query.payload.asTypes,startTime:query.payload.startTime,endTime:query.payload.endTime}};}
 }
 throw Error(`${query.label}分页超过限制，已停止查询`);
}
function publicPlan(plan){return {name:path.basename(plan.workbook),file:plan.workbook,targetName:path.basename(plan.targetWorkbook),cycle:plan.cycle};}
const statusLabels={exact:'精确匹配',alias:'已确认别名',unmatched:'未匹配',ambiguous:'匹配不唯一',review:'待人工核对',below_threshold:'销售不足 50',below_minimum_sales:'销售不足 50',disabled:'未启用',invalid:'数据无效',missing:'缺失',missing_value:'缺少数值',invalid_actual:'实发数量无效',invalid_value:'数据无效'};
const labelStatus=value=>statusLabels[value]||value||'';
const numberCell=value=>value==null||value===''?null:Number.isFinite(Number(value))?Number(value):value;
async function exportPreview(preview,file){
 const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('总表核对');
 sheet.addRow(['Excel行号','货号','商品名称','实发匹配','原实发','新实发','发货前匹配','原发货前退货率','新发货前退货率','发货后匹配','原发货后退货率','新发货后退货率','总退货匹配','原总退货率','新总退货率']);
 for(const r of preview.rows)sheet.addRow([r.row,r.sheet_sku,r.sheet_name,labelStatus(r.actual_status),numberCell(r.old_actual),numberCell(r.new_actual),labelStatus(r.before_return_status),numberCell(r.old_before_return),numberCell(r.new_before_return),labelStatus(r.after_return_status),numberCell(r.old_after_return),numberCell(r.new_after_return),labelStatus(r.return_status),numberCell(r.old_return),numberCell(r.new_return)]);
 for(const col of [8,9,11,12,14,15])sheet.getColumn(col).numFmt='0.00%';
 const review=book.addWorksheet('待核对');review.addRow(['字段','Excel行号','货号','商品名称','状态','候选货号','候选商品']);
 const fieldLabels={actual:'实发数量',before_return:'发货前退货率',after_return:'发货后退货率',return:'总退货率'};
 for(const r of preview.review)review.addRow([fieldLabels[r.field]||r.field,r.row,r.sheet_sku,r.sheet_name,labelStatus(r.status),r.candidate_sku,r.candidate_title]);
 const critical=book.addWorksheet('关键货号校验');critical.addRow(['货号','表内存在','实发匹配','发货前匹配','发货后匹配','总退货匹配','校验通过']);
 for(const r of preview.critical)critical.addRow([r.sku,r.sheet_exists?'是':'否',labelStatus(r.actual_status),labelStatus(r.before_return_status),labelStatus(r.after_return_status),labelStatus(r.return_status),r.passed?'是':'否']);
 for(const s of book.worksheets){s.views=[{state:'frozen',ySplit:1}];s.columns.forEach(c=>c.width=22);}
 centerWorkbook(book);await book.xlsx.writeFile(file);
}
function createMonthlyTool({app,win,dialog,shell,request,progress,runner}){
 let selected=null,preview=null,reportDirectory=null;
 const run=runner||((job)=>runPython(runtimePaths(app),job,progress));
 async function cleanup(){if(preview?.candidate)await fs.unlink(preview.candidate).catch(()=>{});preview=null;}
 async function inspect(file,runDate){return run({action:'inspect',workbook:file,runDate:validateRunDate(runDate)});}
 return {
  async choose(runDate){
   validateRunDate(runDate);
   const result=await dialog.showOpenDialog(win,{title:'选择双姐的分级总表',buttonLabel:'选择总表',properties:['openFile'],filters:[{name:'Excel 工作簿',extensions:['xlsx']}]});
   if(result.canceled)return null;
   const plan=await inspect(result.filePaths[0],runDate);await cleanup();selected=plan;reportDirectory=null;return publicPlan(plan);
  },
  async plan(runDate){if(!selected)throw Error('请先选择总表');await cleanup();selected=await inspect(selected.workbook,runDate);return publicPlan(selected);},
  async preview(runDate){
   if(!selected)throw Error('请先选择总表');await cleanup();
   selected=await inspect(selected.workbook,runDate);
   const root=path.join(app.getPath('userData'),'monthly-runs');await fs.mkdir(root,{recursive:true,mode:0o700});
   const directory=await fs.mkdtemp(path.join(root,selected.cycle.nodeDate+'-'));const inputs={};
   for(const query of selected.queries){const document=await queryDataset(query,request,progress);const file=path.join(directory,query.key+'.json');await fs.writeFile(file,JSON.stringify(document),{mode:0o600});inputs[query.key]=file;}
   preview=await run({action:'prepare',workbook:selected.workbook,sourceHash:selected.sourceHash,runDate,inputs,directory});await exportPreview(preview,path.join(directory,'总表核对明细.xlsx'));reportDirectory=directory;
   return {summary:preview.summary,rows:preview.rows,review:preview.review,critical:preview.critical,reportDirectory};
  },
  async save(){
   if(!preview?.summary.canSave||!preview.receipt)throw Error('请先完成查询，并通过关键货号与工作簿校验');
   const confirm=await dialog.showMessageBox(win,{type:'question',buttons:['取消','备份并更新总表'],defaultId:0,cancelId:0,message:'确认更新总表（双姐）？',detail:`将更新 ${preview.summary.rowCount} 行款式的数据及月份公式。\n保存为：${preview.summary.workbook}\n原表会保留为 .xlsx.bak 备份，请先关闭 Excel/WPS。`});
   if(confirm.response!==1)return null;
   const result=await run({action:'commit',receipt:preview.receipt});preview=null;selected=null;return result;
  },
  async export(){if(!preview)throw Error('请先查询并预览总表');const result=await dialog.showSaveDialog(win,{title:'导出总表核对明细',buttonLabel:'保存',defaultPath:`总表核对明细_${preview.summary.nodeDate}.xlsx`,filters:[{name:'Excel 工作簿',extensions:['xlsx']}]});if(result.canceled)return null;await exportPreview(preview,result.filePath);return result.filePath;},
  async openReports(){if(!reportDirectory)throw Error('请先查询并生成报告');const error=await shell.openPath(reportDirectory);if(error)throw Error('无法打开报告文件夹：'+error);return reportDirectory;},
  cleanup,
 };
}
module.exports={runtimePaths,runPython,validateRunDate,queryDataset,exportPreview,createMonthlyTool};
