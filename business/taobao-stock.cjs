const fs=require('node:fs'),path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const {runtimePaths}=require('./monthly.cjs');
const {browserPath}=require('./taobao.cjs');

function createTaobaoStockTool({app,win,dialog,shell,progress,runner=spawn,
 browserFinder=browserPath,probe=spawnSync}){
 const directory=path.join(app.getPath('userData'),'taobao-stock');
 const scripts=app.isPackaged?path.join(process.resourcesPath,'taobao-stock'):
  path.join(__dirname,'taobao-stock');
 const python=runtimePaths(app).python;
 let worker=null,requestId=0,pending=new Map(),buffer='',selectedExcel=null,lastReport=null;

 function reportPath(value){
  if(typeof value!=='string')return null;
  const reports=path.resolve(directory,'output');
  const resolved=path.resolve(value);
  return resolved.startsWith(reports+path.sep)?resolved:null;
 }
 function failPending(message){
  for(const request of pending.values())request.reject(Error(message));
  pending.clear();
 }
 function receive(line){
  let event;
  try{event=JSON.parse(line);}catch{return;}
  if(event.kind==='progress'){progress(event.message);return;}
  const request=pending.get(event.request_id);if(!request)return;
  pending.delete(event.request_id);
  if(event.kind==='error')request.reject(Error(event.message||'库存同步未完成'));
  else request.resolve(event.data);
 }
 async function ensureWorker(){
  if(worker&&!worker.killed)return;
  const executable=browserFinder();
  if(!executable)throw Error('请先安装 Google Chrome 或 Microsoft Edge');
  const result=probe(python,['-B','-c','import playwright.async_api, openpyxl'],
   {windowsHide:true,stdio:'ignore',timeout:20000});
  if(result.error||result.status!==0)throw Error('工具箱缺少库存同步运行依赖，请安装完整新版工具箱');
  await fs.promises.mkdir(directory,{recursive:true,mode:0o700});
  worker=runner(python,['-B','-X','utf8','-u',path.join(scripts,'bridge.py')],{
   env:{...process.env,STOCK_DATA_ROOT:directory,STOCK_BROWSER_BIN:executable,
    PYTHONUNBUFFERED:'1',PYTHONUTF8:'1'},windowsHide:true,stdio:['pipe','pipe','pipe']
  });
  buffer='';
  worker.stdout.setEncoding('utf8');
  worker.stdout.on('data',chunk=>{
   buffer+=chunk;
   const lines=buffer.split(/\r?\n/);buffer=lines.pop();
   for(const line of lines)if(line.trim())receive(line);
  });
  worker.stderr.setEncoding('utf8');
  worker.stderr.on('data',chunk=>{
   const line=String(chunk).trim();
   if(line)progress('库存同步运行中…');
  });
  worker.on('error',()=>{worker=null;failPending('无法启动库存同步运行环境');});
  worker.on('close',code=>{
   worker=null;
   failPending(code===0?'库存同步进程已结束':'库存同步进程意外退出，请查看任务报告');
  });
 }
 async function call(action,args={}){
  await ensureWorker();
  const id=String(++requestId);
  return new Promise((resolve,reject)=>{
   pending.set(id,{resolve,reject});
   worker.stdin.write(JSON.stringify({action,request_id:id,...args})+'\n',error=>{
    if(!error)return;
    pending.delete(id);reject(Error('库存同步命令发送失败'));
   });
  });
 }
 async function openReport(value){
  const resolved=reportPath(value);
  if(!resolved||!fs.existsSync(resolved))throw Error('简洁报告不存在');
  const error=await shell.openPath(resolved);
  if(error)throw Error(error);
  lastReport=resolved;
  return resolved;
 }
 async function finish(result){
  if(result.report_path){
   try{await openReport(result.report_path);}catch(error){progress(error.message);}
  }
  const c=result.summary||{};
  return {...result,message:`${result.status==='completed'?'同步完成':'任务结束'}：已上架 ${c.listed||0}，全零留库 ${c.zero_stock||0}，跳过 ${c.skipped||0}，失败 ${c.failed||0}，待处理 ${c.pending||0}，未匹配款 ${c['未匹配款']||0}。`};
 }
 return {
  async login(){
   await ensureWorker();
   return call('login');
  },
  async verifyLogin(){return call('verify-login');},
  async choose(){
   const result=await dialog.showOpenDialog(win,{title:'选择淘宝二店库存 Excel',buttonLabel:'开始同步',
    properties:['openFile'],filters:[{name:'Excel 工作簿',extensions:['xlsx']}]});
   if(result.canceled)return null;
   selectedExcel=result.filePaths[0];
   return {name:path.basename(selectedExcel)};
  },
  async start(){
   if(!selectedExcel)throw Error('请先选择库存 Excel');
   progress('正在创建库存同步任务…');
   return finish(await call('start',{excel:selectedExcel}));
  },
  async resume(){
   const {jobs=[]}=await call('jobs');
   const job=jobs.find(item=>item.resumable&&!item.state_corrupt);
   if(!job)throw Error('没有可继续的未完成任务');
   progress('正在继续上次未完成任务…');
   return finish(await call('resume',{run_dir:job.run_dir}));
  },
  async openReport(){
   if(lastReport&&fs.existsSync(lastReport))return openReport(lastReport);
   const result=await call('report');
   return openReport(result.report_path);
  },
  cleanup(){
   if(!worker)return Promise.resolve();
   return new Promise(resolve=>{
    const current=worker;
    const done=()=>resolve();
    current.once('close',done);
    current.stdin.end(JSON.stringify({action:'shutdown',request_id:String(++requestId)})+'\n');
    setTimeout(()=>{if(!current.killed)current.kill();resolve();},3000).unref();
   });
  }
 };
}

module.exports={createTaobaoStockTool};
