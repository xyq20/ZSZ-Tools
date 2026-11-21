const disk = require('node:fs');
const fs = disk.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {newer} = require('../updater.cjs');

const STORE = '.toolkit-versions';
const SLOT = /^(\d+\.\d+\.\d+)-[a-f0-9]{32}$/;
const EXE = '钊叔工具箱.exe';

function slotStore(executable) {
  const slot = path.dirname(executable);
  const store = path.dirname(slot);
  return path.basename(store) === STORE && SLOT.test(path.basename(slot)) ? store : null;
}

function personalStore(executable, version) {
  const origin = disk.realpathSync.native(executable).toLowerCase();
  const id = crypto.createHash('sha256').update(origin + '\0' + version).digest('hex').slice(0,32);
  return path.join(process.env.LOCALAPPDATA, 'team-toolkit', 'installations', id, STORE);
}

function standardToken(executable) {
  // A privileged installed entry must never dispatch into a user's writable cache.
  const python = path.join(path.dirname(executable),'resources','python','python.exe');
  const stdout = execFileSync(python,['-I','-B','-c',
    'import ctypes; print(int(bool(ctypes.windll.shell32.IsUserAnAdmin())))'],{windowsHide:true,timeout:10000,encoding:'utf8'});
  return stdout.trim() === '0';
}

function readActive(store) {
  try {
    const value = JSON.parse(disk.readFileSync(path.join(store,'active.json'),'utf8'));
    return typeof value.slot === 'string' && SLOT.test(value.slot) ? value : null;
  } catch(error) {
    if(error.code==='ENOENT' || error instanceof SyntaxError)return null;
    throw error;
  }
}

async function cleanRetired(store,running) {
  const active=readActive(store)?.slot;
  for(const entry of await fs.readdir(store,{withFileTypes:true})){
    if(!entry.isDirectory()||entry.name===active||entry.name===running)continue;
    const retired=/^(\d+\.\d+\.\d+-[a-f0-9]{32})\.retired-[a-f0-9]{32}$/.test(entry.name);
    const directory=path.join(store,entry.name);
    if(!retired){
      if(!SLOT.test(entry.name))continue;
      const marker=await fs.lstat(path.join(directory,'.toolkit-retired')).catch(()=>null);
      if(!marker?.isFile())continue;
    }
    await fs.rm(directory,{recursive:true,force:true,maxRetries:2,retryDelay:100}).catch(()=>{});
  }
}
async function prepareStore(executable, current) {
  const previous = slotStore(executable);
  if(previous){await cleanRetired(previous,path.basename(path.dirname(executable)));return previous;}
  const installed = path.join(path.dirname(executable),STORE);
  try {
    await fs.mkdir(installed,{recursive:true});
    // W_OK alone does not check Windows ACLs.
    const probe=await fs.mkdtemp(path.join(installed,'.check-'));
    await fs.rmdir(probe);
    return installed;
  } catch(error) {
    if(!['EPERM','EACCES','EROFS'].includes(error.code) || !standardToken(executable))throw error;
    const personal=personalStore(executable,current);
    await fs.mkdir(personal,{recursive:true,mode:0o700});
    return personal;
  }
}

// Select the normal entry synchronously so Electron sees its main startup handlers before ready.
function launchTarget(executable, version) {
  if(slotStore(executable))return null;
  const installed=path.join(path.dirname(executable),STORE);
  const stores=[installed];
  if(disk.existsSync(path.join(process.env.LOCALAPPDATA,'team-toolkit','installations'))){
    stores.push(personalStore(executable,version));
  }
  let selected=null;
  for(const store of stores){
    try{
      const active=readActive(store);
      if(!active)continue;
      const next=SLOT.exec(active.slot)[1];
      if(!newer(next,selected?.version||version))continue;
      if(store!==installed&&!standardToken(executable))continue;
      const file=path.join(store,active.slot,EXE);
      if(disk.lstatSync(file).isFile())selected={version:next,file};
    }catch(error){
      if(!['ENOENT','ENOTDIR','EACCES','EPERM'].includes(error.code))console.warn('无法读取已安装的更新：',error.message);
    }
  }
  return selected?.file||null;
}

module.exports={prepareStore,readActive,launchTarget,slotStore,EXE};
