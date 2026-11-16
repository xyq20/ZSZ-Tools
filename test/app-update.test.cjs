const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {promisify}=require('node:util'),exec=promisify(require('node:child_process').execFile);
const {validateAsset,allowedURL,downloadFile,verifyFile,createUpdater,macScript}=require('../business/app-update.cjs');
const bytes=Buffer.from('verified installer'),sha256=crypto.createHash('sha256').update(bytes).digest('hex');
function release(){return {tag_name:'v0.4.19',assets:[{name:'-0.4.19-mac-arm64.dmg',browser_download_url:'https://github.com/xyq20/ZSZ-Tools/releases/download/v0.4.19/-0.4.19-mac-arm64.dmg',size:bytes.length,digest:'sha256:'+sha256}]};}
const info=()=>validateAsset(release(),'0.4.18','darwin','arm64');
test('automatic update requires exact release version, trusted URL, size and SHA-256',()=>{
 assert.equal(info().sha256,sha256);
 for(const change of [r=>delete r.assets[0].digest,r=>r.assets[0].size=0,r=>r.assets[0].digest='sha256:bad',r=>r.assets[0].browser_download_url=r.assets[0].browser_download_url.replace('/v0.4.19/','/v0.4.18/')]){const r=release();change(r);assert.throws(()=>validateAsset(r,'0.4.18','darwin','arm64'));}
 for(const url of ['http://github.com/x','https://evil.example/x','https://github.com.evil.example/x','https://user:password@github.com/x'])assert.throws(()=>allowedURL(url));
 assert.equal(allowedURL('https://release-assets.githubusercontent.com/file').hostname,'release-assets.githubusercontent.com');
});
test('download only promotes complete verified bytes; corrupt, truncated, excessive and cancelled files leave no partial',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'update-download-')),file=path.join(dir,'installer');
 try{
  const progress=[];await downloadFile(info(),file,{getResponse:async()=>Readable.from([bytes]),onProgress:(n)=>progress.push(n)});await verifyFile(file,info());assert.equal(progress.at(-1),bytes.length);
  for(const data of [Buffer.from('x'),Buffer.alloc(bytes.length,1),Buffer.alloc(bytes.length+1)]){
   await assert.rejects(downloadFile(info(),file,{getResponse:async()=>Readable.from([data])}));assert.deepEqual(await fs.readFile(file),bytes);await assert.rejects(fs.stat(file+'.part'));
  }
  const controller=new AbortController();controller.abort();await assert.rejects(downloadFile(info(),file,{signal:controller.signal,getResponse:async()=>Readable.from([bytes])}));await assert.rejects(fs.stat(file+'.part'));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('update controller deduplicates download, blocks busy installs, preserves login before helper and retries errors',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'update-state-'));let busy=false,locked=false,downloads=0,flushFails=false;const events=[];
 const business={isBusy:()=>busy,beginUpdate:()=>{if(busy)throw Error('busy');locked=true;events.push('lock');},endUpdate:()=>{locked=false;},flushLogin:async()=>{events.push('flush');if(flushFails)throw Error('flush failed');}};
 const app={isPackaged:true,getVersion:()=> '0.4.18',getPath:k=>k==='exe'?'/Applications/test.app/Contents/MacOS/test':dir,quit:()=>events.push('quit')};
 const updater=createUpdater({app,business,platform:'darwin',arch:'arm64',fetchRelease:async()=>release(),downloader:async(i,f)=>{downloads++;await fs.writeFile(f,bytes);},prepare:async()=>({staged:path.join(dir,'staged')}),launch:async()=>events.push('launch')});
 try{
  const checked=await updater.check();assert.equal(checked.status,'available');assert.equal(checked.message,'');await Promise.all([updater.download(),updater.download()]);assert.equal(downloads,1);
  busy=true;await assert.rejects(updater.install(),/任务/);assert.equal(locked,false);busy=false;
  flushFails=true;await assert.rejects(updater.install(),/flush failed/);assert.equal(locked,false);assert.equal(updater.state().status,'downloaded');assert(!events.includes('launch'));
  flushFails=false;events.length=0;await updater.install();assert.deepEqual(events,['lock','flush','launch','quit']);assert(updater.canQuit());
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('Mac replacement helper confirms healthy launch and restores old app on startup failure',{skip:process.platform!=='darwin'},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"update helper's "));
 try{
  for(const healthy of [true,false]){
   const dir=path.join(root,String(healthy));await fs.mkdir(dir);const target=path.join(dir,'工具箱.app'),staged=path.join(dir,'staged.app'),backup=path.join(dir,'backup.app'),ack=path.join(dir,'healthy');
   await fs.mkdir(target);await fs.writeFile(path.join(target,'old'),'old');await fs.mkdir(path.join(staged,'Contents/MacOS'),{recursive:true});
   const binary=path.join(staged,'Contents/MacOS/test');await fs.writeFile(binary,healthy?'#!/bin/sh\nprintf ok > "$ACK"\nsleep 3\n':'#!/bin/sh\nexit 1\n',{mode:0o700});
   const helper=path.join(dir,'helper.sh');await fs.writeFile(helper,macScript());
   try{await exec('/bin/sh',[helper,'99999999',target,staged,backup,ack,'token','test'],{env:{...process.env,ACK:ack},timeout:15000});}catch(e){if(healthy)throw e;}
   if(healthy){assert.equal(await fs.readFile(ack,'utf8'),'ok');await assert.rejects(fs.stat(backup));assert((await fs.stat(path.join(target,'Contents'))).isDirectory());}
   else{assert.equal(await fs.readFile(path.join(target,'old'),'utf8'),'old');assert.match(await fs.readFile(ack+'.failed','utf8'),/恢复旧版/);}
  }
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
