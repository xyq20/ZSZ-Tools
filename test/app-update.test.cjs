const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {promisify}=require('node:util'),exec=promisify(require('node:child_process').execFile);
const {validateAsset,allowedURL,downloadFile,verifyFile,createUpdater,acknowledgeUpdate}=require('../business/app-update.cjs');
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
 const updater=createUpdater({app,business,platform:'darwin',arch:'arm64',fetchRelease:async()=>release(),downloader:async(i,f)=>{downloads++;await fs.writeFile(f,bytes);},prepare:async()=>{events.push('prepare');return {staged:path.join(dir,'staged')};},validatePrepared:async()=>{},launch:async()=>events.push('launch')});
 try{
  const checked=await updater.check();assert.equal(checked.status,'available');assert.equal(checked.message,'');await Promise.all([updater.download(),updater.download()]);assert.equal(downloads,1);assert.deepEqual(events,['prepare']);
  busy=true;await assert.rejects(updater.install(),/任务/);assert.equal(locked,false);busy=false;
  flushFails=true;await assert.rejects(updater.install(),/flush failed/);assert.equal(locked,false);assert.equal(updater.state().status,'downloaded');assert(!events.includes('launch'));
  flushFails=false;events.length=0;await updater.install();assert.deepEqual(events,['lock','flush','launch','quit']);assert(updater.canQuit());
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('Windows prefers the exact matching authenticated hot payload and rejects an ambiguous offer',()=>{
 const asset=ext=>({name:'-0.4.19-win-x64.'+ext,browser_download_url:'https://github.com/xyq20/ZSZ-Tools/releases/download/v0.4.19/-0.4.19-win-x64.'+ext,size:99,digest:'sha256:'+sha256});
 const r={tag_name:'v0.4.19',assets:[asset('zip'),asset('exe')]};
 assert.equal(validateAsset(r,'0.4.18','win32','x64').kind,'windows-hot');
 for(const url of ['https://other.invalid/test.zip',asset('exe').browser_download_url]){
  const modified={...r,assets:[{...asset('zip'),browser_download_url:url},asset('exe')]};
  assert.throws(()=>validateAsset(modified,'0.4.18','win32','x64'));
 }
 assert.throws(()=>validateAsset({...r,assets:[...r.assets,asset('zip')]},'0.4.18','win32','x64'));
});
test('only the requested interactive visible process writes a hot-update window receipt',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'toolkit-window-'));
 t.after(()=>fs.rm(root,{force:true,recursive:true}));
 const directory=path.join(root,'updates','0.4.19-win32-x64'),token='f'.repeat(32);
 await fs.mkdir(directory,{recursive:true});
 const pending=path.join(root,'updates','pending.json'),windowFile=path.join(directory,'window-'+token+'.json');
 await fs.writeFile(pending,JSON.stringify({schema:2,directory,token,version:'0.4.19'}));
 const app={getVersion:()=>'0.4.19',getPath:()=>root};
 const ack=(visible,interactive)=>acknowledgeUpdate(app,'win32',{visible,interactive,focused:true});
 await ack(true,true);await assert.rejects(fs.stat(windowFile),{code:'ENOENT'});
 process.argv.push('--toolkit-update-token='+token);
 try{
  await ack(false,true);await ack(true,false);await assert.rejects(fs.stat(windowFile),{code:'ENOENT'});
  await ack(true,true);
 }finally{process.argv.pop();}
 const proof=JSON.parse(await fs.readFile(windowFile));
 assert.equal(proof.pid,process.pid);assert.equal(proof.token,token);assert.equal(proof.executable,process.execPath);
 await fs.stat(pending);await assert.rejects(fs.stat(path.join(directory,'healthy')),{code:'ENOENT'});
});
