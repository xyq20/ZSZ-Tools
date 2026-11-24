const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {warmWindows}=require('../business/hot-update.cjs');
const {EXE}=require('../business/windows-versions.cjs');
test('Windows preparation starts the new program once as Node and reads its startup files',{skip:process.platform==='win32'&&'uses a shell script as the program'},async()=>{
 const staged=await fs.mkdtemp(path.join(os.tmpdir(),'update-warm-')),resources=path.join(staged,'resources'),proof=path.join(staged,'proof');
 try{
  await fs.mkdir(resources);await fs.writeFile(path.join(resources,'app.asar'),Buffer.alloc(3*1024*1024));
  await fs.writeFile(path.join(staged,EXE),`#!/bin/sh\nprintf '%s %s %s' "$ELECTRON_RUN_AS_NODE" "$1" "$2" > '${proof}'\n`,{mode:0o700});
  await warmWindows(staged,resources,new AbortController().signal);
  assert.equal(await fs.readFile(proof,'utf8'),'1 -e 0');
  // A failed warm-up only loses the speedup; it must not block the update.
  await fs.writeFile(path.join(staged,EXE),'#!/bin/sh\nexit 3\n',{mode:0o700});
  await warmWindows(staged,resources,new AbortController().signal);
  const controller=new AbortController();controller.abort();
  await assert.rejects(warmWindows(staged,resources,controller.signal),{name:'AbortError'});
 }finally{await fs.rm(staged,{recursive:true,force:true});}
});
