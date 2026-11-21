const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn, execFile} = require('node:child_process');
const exec = require('node:util').promisify(execFile);
const {newer} = require('../updater.cjs');

const STORE = '.toolkit-versions';
const SLOT = /^(\d+\.\d+\.\d+)-[a-f0-9]{32}$/;
const EXE = '钊叔工具箱.exe';

function slotStore(executable) {
  const slot = path.dirname(executable);
  const store = path.dirname(slot);
  return path.basename(store) === STORE && SLOT.test(path.basename(slot)) ? store : null;
}

async function personalStore(executable, version) {
  const origin = (await fs.realpath(executable)).toLowerCase();
  const id = crypto.createHash('sha256').update(origin + '\0' + version).digest('hex').slice(0,32);
  return path.join(process.env.LOCALAPPDATA, 'team-toolkit', 'installations', id, STORE);
}

async function standardToken(executable) {
  // A privileged installed entry must never dispatch into a user's writable cache.
  const python = path.join(path.dirname(executable),'resources','python','python.exe');
  const {stdout} = await exec(python,['-I','-B','-c',
    'import ctypes; print(int(bool(ctypes.windll.shell32.IsUserAnAdmin())))'],{windowsHide:true,timeout:10000});
  return stdout.trim() === '0';
}

async function readActive(store) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(store,'active.json'),'utf8'));
    return typeof value.slot === 'string' && SLOT.test(value.slot) ? value : null;
  } catch(error) {
    if(error.code==='ENOENT' || error instanceof SyntaxError)return null;
    throw error;
  }
}

async function prepareStore(executable, current) {
  const previous = slotStore(executable);
  if(previous)return previous;
  const installed = path.join(path.dirname(executable),STORE);
  try {
    await fs.mkdir(installed,{recursive:true});
    // W_OK alone does not check Windows ACLs.
    const probe=await fs.mkdtemp(path.join(installed,'.check-'));
    await fs.rmdir(probe);
    return installed;
  } catch(error) {
    if(!['EPERM','EACCES','EROFS'].includes(error.code) || !await standardToken(executable))throw error;
    const personal=await personalStore(executable,current);
    await fs.mkdir(personal,{recursive:true,mode:0o700});
    return personal;
  }
}

async function redirect(executable, version, args) {
  if(slotStore(executable))return false;
  const installed=path.join(path.dirname(executable),STORE);
  const personal=await personalStore(executable,version);
  const candidates=[];
  for(const store of [installed,personal]){
    const active=await readActive(store);
    if(!active)continue;
    const candidateVersion=SLOT.exec(active.slot)[1];
    if(!newer(candidateVersion,version))continue;
    if(store===personal && !await standardToken(executable))continue;
    candidates.push({version:candidateVersion,file:path.join(store,active.slot,EXE)});
  }
  candidates.sort((a,b)=>newer(a.version,b.version)?-1:newer(b.version,a.version)?1:0);
  for(const candidate of candidates){
    try {
      const child=spawn(candidate.file,args,{cwd:path.dirname(candidate.file),detached:true,stdio:'ignore'});
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
      child.unref();
      return true;
    } catch(error) {
      if(!['ENOENT','ENOTDIR','EACCES','EPERM'].includes(error.code))throw error;
    }
  }
  return false;
}

module.exports={prepareStore,readActive,redirect,slotStore,EXE};
