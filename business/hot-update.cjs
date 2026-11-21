const fs = require('node:fs/promises');
const physical = process.versions.electron ? require('original-fs').promises : fs;
const path = require('node:path');
const {execFile, spawn} = require('node:child_process');
const exec = require('node:util').promisify(execFile);
const {setTimeout:delay} = require('node:timers/promises');
const {prepareStore, readActive, EXE} = require('./windows-versions.cjs');

function runtime(resources, platform) {
  return {
    python: path.join(resources,'python',platform==='win32'?'python.exe':'bin/python3.12'),
    script: path.join(resources,'toolkit-update.py'),
  };
}

async function macPayload({file,directory,executable,version,token,signal}) {
  const target = path.resolve(executable,'../../..');
  if(!target.endsWith('.app') || target.includes('/AppTranslocation/') || target.startsWith('/Volumes/')) {
    throw Error('请先将工具箱放入“应用程序”后再更新');
  }
  const parent=path.dirname(target);
  const staged=path.join(parent,'.toolkit-update-'+token+'.app');
  const mount=path.join(directory,'mount-'+token);
  await fs.mkdir(mount,{mode:0o700});
  let attached=false,owned=false;
  try {
    // Finish attachment before honoring cancellation so the image can always be detached.
    await exec('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,file],{timeout:120000});
    attached=true;
    signal.throwIfAborted();
    const source=path.join(mount,'钊叔工具箱.app');
    const plist=path.join(source,'Contents/Info.plist');
    for(const [key,expected] of Object.entries({CFBundleIdentifier:'local.team.toolkit',CFBundleShortVersionString:version,CFBundleExecutable:'钊叔工具箱'})){
      const {stdout}=await exec('/usr/bin/plutil',['-extract',key,'raw','-o','-',plist],{signal});
      if(stdout.trim()!==expected)throw Error('更新包中的应用身份或版本不匹配');
    }
    await fs.mkdir(staged,{mode:0o700});owned=true;
    await exec('/usr/bin/ditto',[source,staged],{timeout:240000,signal});
    return {target,staged,binary:path.join(staged,'Contents/MacOS/钊叔工具箱'),resources:path.join(staged,'Contents/Resources')};
  } catch(error) {
    if(owned)await fs.rm(staged,{recursive:true,force:true});
    throw error;
  } finally {
    if(attached)await exec('/usr/bin/hdiutil',['detach',mount],{timeout:30000}).catch(()=>
      exec('/usr/bin/hdiutil',['detach','-force',mount],{timeout:30000})).catch(async error=>{
       if(owned)await fs.rm(staged,{recursive:true,force:true});
       throw error;
      });
    await fs.rmdir(mount).catch(()=>{});
  }
}

async function windowsPayload({file,executable,current,version,token,signal,resources}) {
  const store=await prepareStore(executable,current);
  const previousActive=await readActive(store);
  const staged=path.join(store,version+'-'+token);
  const worker=runtime(resources,'win32');
  await fs.mkdir(staged,{mode:0o700});
  try {
    await exec(worker.python,['-I','-B','-X','utf8',worker.script,'extract',file,staged],{windowsHide:true,timeout:300000,signal});
    const next=path.join(staged,'resources');
    const metadata=JSON.parse(await fs.readFile(path.join(next,'app.asar','package.json'),'utf8'));
    if(metadata.name!=='team-toolkit'||metadata.version!==version)throw Error('更新包中的应用身份或版本不匹配');
    // Local defaults belong to this installation; the public payload does not carry them.
    const defaults='taobao-reminders-defaults.json';
    try{await fs.copyFile(path.join(resources,defaults),path.join(next,defaults),require('node:fs').constants.COPYFILE_EXCL);}
    catch(error){if(!['ENOENT','EEXIST'].includes(error.code))throw error;}
    return {staged,previousActive,binary:path.join(staged,EXE),resources:next};
  } catch(error) {
    await fs.rm(staged,{recursive:true,force:true,maxRetries:5,retryDelay:150});
    throw error;
  }
}

async function fingerprint(file) {
  const stat=await physical.lstat(file,{bigint:true});
  if(!stat.isFile())throw Error('新版程序文件无效，请重新下载');
  return [stat.dev,stat.ino,stat.size,stat.mtimeNs].join('/');
}

async function prepareHot(options) {
  const prepared=options.platform==='win32'?await windowsPayload(options):await macPayload(options);
  try{
    const nextRuntime=runtime(prepared.resources,options.platform);
    const files=[prepared.binary,path.join(prepared.resources,'app.asar'),nextRuntime.python,nextRuntime.script];
    prepared.files=files;
    prepared.stamps=await Promise.all(files.map(fingerprint));
    prepared.worker=runtime(options.resources,options.platform);
    options.signal.throwIfAborted();
    return prepared;
  }catch(error){
    await fs.rm(prepared.staged,{recursive:true,force:true});
    throw error;
  }
}

async function assertPrepared(prepared) {
  const current=await Promise.all(prepared.files.map(fingerprint));
  if(current.some((value,index)=>value!==prepared.stamps[index]))throw Error('已准备的新版发生变化，请重新准备更新');
}

async function launchHot({prepared,executable,directory,token,version,clickedAt}) {
  const plan={staged:prepared.staged,target:prepared.target,previousActive:prepared.previousActive,
    executable,directory,token,version,clickedAt,parentPid:process.pid};
  const ready=path.join(directory,'helper-'+token+'.ready');
  const handle=await fs.open(path.join(directory,'install-helper.log'),'w',0o600);
  try{
    const child=spawn(prepared.worker.python,['-I','-B','-X','utf8',prepared.worker.script,'switch',JSON.stringify(plan)],
      {cwd:directory,detached:true,windowsHide:true,stdio:['ignore',handle.fd,handle.fd]});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    const end=Date.now()+10000;
    while(child.exitCode===null && child.signalCode===null && Date.now()<end){
      if(await fs.access(ready).then(()=>true,()=>false)){child.unref();return;}
      await delay(25);
    }
    if(child.exitCode===null && child.signalCode===null)child.kill();
    throw Error('更新助手未就绪，请查看 '+path.join(directory,'install-helper.log'));
  }finally{
    await handle.close();
  }
}

module.exports={prepareHot,assertPrepared,launchHot};
