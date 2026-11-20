const fs=require('node:fs/promises');
const {createReadStream}=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');

async function verifyFile(file,info){
 const stat=await fs.lstat(file);
 if(!stat.isFile()||stat.size!==info.size)throw Error('安装包大小校验失败，请重新下载');
 const hash=crypto.createHash('sha256');
 for await(const chunk of createReadStream(file))hash.update(chunk);
 if(hash.digest('hex')!==info.sha256)throw Error('安装包校验失败，请重新下载');
}

function isRunning(pid){
 try{process.kill(pid,0);return true;}
 catch(error){if(error.code==='ESRCH')return false;throw error;}
}

async function waitFor(check,timeout){
 const deadline=Date.now()+timeout;
 do{
  if(await check())return true;
  await delay(100);
 }while(Date.now()<deadline);
 return false;
}

function runInstaller(file){
 const child=spawn(file,['/S','--updated'],{windowsHide:true,stdio:'ignore'});
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.unref();resolve(null);},300000);
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('exit',code=>{clearTimeout(timer);resolve(code??-1);});
 });
}

async function openToolbox(executable){
 const child=spawn(executable,['--updated'],{detached:true,stdio:'ignore'});
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
 child.unref();
 return child;
}

async function applyWindowsUpdate({parentPid,file,info,executable,directory,token}){
 const log=path.join(directory,'install.log');
 const append=message=>fs.appendFile(log,message+'\r\n');
 const healthy=path.join(directory,'healthy');
 let mayReopen=false;
 let launched;
 try{
  await fs.writeFile(log,'正在等待旧版工具箱退出\r\n');
  await fs.writeFile(path.join(directory,`helper-${token}.ready`),'ready',{flag:'wx'});
  if(!await waitFor(()=>!isRunning(parentPid),15000))throw Error('旧版工具箱未退出，请关闭后重试');
  mayReopen=true;
  await verifyFile(file,info);
  await append('正在后台应用更新');
  const exitCode=await runInstaller(file);
  if(exitCode===null){mayReopen=false;throw Error('后台更新等待超时，请检查 Windows 管理员授权提示');}
  if(exitCode!==0)throw Error(`后台更新失败，安装器退出码 ${exitCode}`);
  await append('正在启动工具箱并等待新版确认');
  launched=await openToolbox(executable);
  if(!await waitFor(()=>fs.access(healthy).then(()=>true,()=>false),45000))throw Error('工具箱未确认新版已启动');
  await append('新版工具箱已启动');
 }catch(error){
  await append(error.message).catch(()=>{});
  await fs.writeFile(healthy+'.failed',error.message).catch(()=>{});
  if(mayReopen&&!launched)await openToolbox(executable).catch(()=>{});
  throw error;
 }
}

if(require.main===module){
 applyWindowsUpdate(JSON.parse(process.argv[2])).catch(error=>{console.error(error.message);process.exitCode=1;});
}

module.exports={verifyFile};
