const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {runtimePaths}=require('./monthly.cjs');
function validateOptions(options={}){
 const mode=options.mode||'all',color=options.color||'default',name=String(options.name||'').trim();
 if(!['all','charts','flow','main-pic'].includes(mode)||!['default','all'].includes(color)||name.length>2000)throw Error('抓取选项无效');
 return ['--mode',mode,'--color',color==='all'?'all':'粉,紫,黄,蓝',...(name?['--name',name]:[])];
}
async function findChrome(){
 const candidates=process.platform==='darwin'?['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']:['LOCALAPPDATA','PROGRAMFILES','PROGRAMFILES(X86)'].flatMap(k=>process.env[k]?[path.join(process.env[k],'Google/Chrome/Application/chrome.exe'),path.join(process.env[k],'Microsoft/Edge/Application/msedge.exe')]:[]);
 for(const file of candidates){try{await fs.access(file);return file;}catch{}}
 throw Error('请先安装 Google Chrome 或 Microsoft Edge');
}
function runProcess(python,args,env,progress){
 return new Promise((resolve,reject)=>{
  const child=spawn(python,args,{env:{...process.env,...env,PYTHONUNBUFFERED:'1',PYTHONUTF8:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let tail='',pending='';
  const consume=chunk=>{tail=(tail+chunk).slice(-10000);pending+=chunk;const lines=pending.split(/\r?\n/);pending=lines.pop();for(const line of lines)if(line.trim())progress(line);};
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',consume);child.stderr.on('data',consume);
  child.on('error',e=>reject(Error(e.code==='ENOENT'?'生意参谋运行环境缺失，请安装完整工具箱':e.message)));
  child.on('close',code=>{if(pending.trim())progress(pending);resolve({code,tail});});
 });
}
function createSycmTool({app,win,dialog,shell,progress,runner=runProcess,chromeFinder=findChrome}){
 let selected=null,lastDirectory=null;
 const root=path.join(app.getPath('userData'),'sycm'),auth=path.join(root,'auth');
 const scripts=app.isPackaged?path.join(process.resourcesPath,'sycm-python'):path.join(__dirname,'sycm-python');
 const python=runtimePaths(app).python;
 async function execute(script,directory,args=[]){
  const chrome=await chromeFinder();await fs.mkdir(auth,{recursive:true,mode:0o700});
  const env={SYCM_DATA_DIR:directory,SYCM_AUTH_DIR:auth,SYCM_CHROME_BIN:chrome};
  const check=await runner(python,['-B','-X','utf8','-c','import playwright.sync_api, openpyxl, PIL; from zoneinfo import ZoneInfo; ZoneInfo("Asia/Shanghai")'],env,()=>{});
  if(check.code!==0)throw Error('生意参谋 Python 依赖缺失，请安装包含生意参谋依赖的完整新版工具箱');
  return runner(python,['-B','-X','utf8','-u',path.join(scripts,script),...args],env,progress);
 }
 async function loadTask(){
  const task=JSON.parse(await fs.readFile(path.join(root,'last-task.json'),'utf8'));
  const runs=path.join(root,'runs')+path.sep;
  if(typeof task.directory!=='string'||!path.resolve(task.directory).startsWith(runs)||!Array.isArray(task.args))throw Error('上轮记录无效，请开始新一轮');
  // Rebuild arguments from validated options, never trust stored command arguments.
  task.args=validateOptions(task.options);lastDirectory=task.directory;return task;
 }
 async function perform(task,resume=false){
  const progressFile=path.join(task.directory,'output/sycm/progress.json');await fs.rm(progressFile,{force:true});
  const result=await execute('run.py',task.directory,[...task.args,...(resume?['--resume']:[])]);
  await fs.appendFile(path.join(task.directory,'运行日志.txt'),result.tail+'\n');
  let summary;try{summary=JSON.parse(await fs.readFile(progressFile,'utf8'));}catch{}
  if(!summary||!['done','incomplete'].includes(summary.stage))throw Error((result.tail||'抓取未正常结束')+'\n可打开结果文件夹查看数据，或点击继续上轮。');
  const files=(await fs.readdir(task.directory)).filter(n=>n.toLowerCase().endsWith('.xlsx')&&!n.startsWith('~$'));
  const filename=files.find(n=>n.includes('-已填'))||files[0];
  const incomplete=result.code!==0||summary.stage!=='done'||(summary.fail||0)>0||summary.index<summary.total;
  return {file:filename?path.join(task.directory,filename):task.directory,directory:task.directory,summary,incomplete};
 }
 return {
  async choose(){const r=await dialog.showOpenDialog(win,{title:'选择生意参谋分级总表（生成本机副本）',properties:['openFile'],filters:[{name:'Excel 工作簿',extensions:['xlsx']}]});if(r.canceled)return null;const file=r.filePaths[0];if(path.extname(file).toLowerCase()!=='.xlsx'||/^(~\$|\.)/.test(path.basename(file)))throw Error('请选择正式的 .xlsx 总表');await fs.access(file);selected=file;return {file};},
  async login(){await fs.mkdir(root,{recursive:true,mode:0o700});const result=await execute('sycm_login.py',root);if(result.code!==0)throw Error(result.tail||'登录未完成');return {message:'登录已保存，可以选择总表并开始抓取。'};},
  async start(options={}){
   if(!selected)throw Error('请先选择分级总表');const args=validateOptions(options);
   const runs=path.join(root,'runs');await fs.mkdir(runs,{recursive:true,mode:0o700});
   lastDirectory=await fs.mkdtemp(path.join(runs,'run-'));
   // Keep the source basename so the Python monthly naming rule can apply.
   const filename=path.basename(selected).replace(/(?:-已填|\.patched|\.cleared(?:-main-pic)?)\.xlsx$/i,'.xlsx');
   await fs.copyFile(selected,path.join(lastDirectory,filename));
   const task={directory:lastDirectory,args,options};await fs.writeFile(path.join(root,'last-task.json'),JSON.stringify(task),{mode:0o600});
   progress('已创建本机副本，开始新一轮全量刷新…');return perform(task);
  },
  async resume(){let task;try{task=await loadTask();}catch{throw Error('没有可继续的上轮任务，请先选择总表开始新一轮');}progress('正在继续上轮，沿用上轮模式和筛选范围…');return perform(task,true);},
  async results(){if(!lastDirectory){try{await loadTask();}catch{throw Error('尚未生成本次结果');}}const error=await shell.openPath(lastDirectory);if(error)throw Error(error);return lastDirectory;},
 };
}
module.exports={createSycmTool,validateOptions,runProcess};
