const fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
const {runtimePaths}=require('./monthly.cjs');
const {browserPath}=require('./taobao.cjs');

function createTaobaoStockTool({app,win,dialog,shell,progress,runner=spawn,
 browserFinder=browserPath,loginTimeoutMs=90000}){
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
  await fs.promises.mkdir(directory,{recursive:true,mode:0o700});
  worker=runner(python,['-B','-X','utf8','-u',path.join(scripts,'bridge.py')],{
   env:{...process.env,STOCK_DATA_ROOT:directory,STOCK_BROWSER_BIN:executable,
    PYTHONUNBUFFERED:'1',PYTHONUTF8:'1'},windowsHide:true,stdio:['pipe','pipe','pipe']
  });
  const current=worker;
  const disconnect=message=>{
   if(worker!==current)return;
   worker=null;
   failPending(message);
  };
  buffer='';
  worker.stdout.setEncoding('utf8');
  worker.stdout.on('data',chunk=>{
   if(worker!==current)return;
   buffer+=chunk;
   const lines=buffer.split(/\r?\n/);buffer=lines.pop();
   for(const line of lines)if(line.trim())receive(line);
  });
  worker.stderr.setEncoding('utf8');
  worker.stderr.on('data',chunk=>{
   const line=String(chunk).trim();
   if(line)progress('库存同步运行中…');
  });
  worker.stdin.on?.('error',()=>disconnect('库存进程连接已断开，请重试'));
  worker.on('error',()=>disconnect('无法启动库存同步运行环境，请检查工具箱安装'));
  worker.on('exit',code=>disconnect(code===0?'库存同步进程已结束':'库存同步组件启动或运行失败，请检查工具箱安装后重试'));
  worker.on('close',()=>disconnect('库存同步进程已关闭，请重试'));
 }
 async function call(action,args={}){
  await ensureWorker();
  const id=String(++requestId);
  const current=worker;
  if(!current)throw Error('库存同步组件未启动，请重试');
  return new Promise((resolve,reject)=>{
   const timer=['login','verify-login'].includes(action)?setTimeout(()=>{
    if(worker!==current)return;
    worker=null;
    failPending('二店登录响应超时，请检查浏览器和网络后重试');
    current.kill();
   },loginTimeoutMs):null;
   pending.set(id,{
    resolve:data=>{clearTimeout(timer);resolve(data);},
    reject:error=>{clearTimeout(timer);reject(error);}
   });
   current.stdin.write(JSON.stringify({action,request_id:id,...args})+'\n',error=>{
    if(!error)return;
    const request=pending.get(id);
    pending.delete(id);
    request?.reject(Error('库存同步命令发送失败，请重试'));
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
   progress('正在打开二店专用浏览器…');
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
    const done=()=>{
     clearTimeout(timer);
     current.removeListener('close',done);
     resolve();
    };
    const timer=setTimeout(()=>{if(!current.killed)current.kill();done();},3000);
    timer.unref();
    current.once('close',done);
    current.stdin.end(JSON.stringify({action:'shutdown',request_id:String(++requestId)})+'\n');
   });
  }
 };
}

module.exports={createTaobaoStockTool};
