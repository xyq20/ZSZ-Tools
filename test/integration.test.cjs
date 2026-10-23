const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('tool import is explicit, hash locked, and packaged verification needs no source folders',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tool-import-'));
 try{
  const app=path.join(dir,'app'),source=path.join(dir,'source');fs.mkdirSync(path.join(app,'scripts'),{recursive:true});fs.mkdirSync(path.join(app,'integration'));fs.mkdirSync(source);
  fs.copyFileSync(path.join(__dirname,'../scripts/sync-tools.cjs'),path.join(app,'scripts/sync-tools.cjs'));
  fs.writeFileSync(path.join(source,'core.js'),'v1');fs.writeFileSync(path.join(source,'private.xlsx'),'must not copy');
  fs.writeFileSync(path.join(app,'integration/tools.json'),JSON.stringify({tools:{demo:{source:'../source',files:{'core.js':'modules/demo/core.js'}}}}));
  const run=(...args)=>spawnSync(process.execPath,['scripts/sync-tools.cjs',...args],{cwd:app,encoding:'utf8'});
  assert.equal(run().status,0);assert(!fs.existsSync(path.join(app,'modules')));
  assert.equal(run('--apply').status,0);assert.equal(fs.readFileSync(path.join(app,'modules/demo/core.js'),'utf8'),'v1');assert.deepEqual(fs.readdirSync(path.join(app,'modules/demo')),['core.js']);
  fs.writeFileSync(path.join(source,'core.js'),'v2');assert.equal(run().status,0);assert.equal(fs.readFileSync(path.join(app,'modules/demo/core.js'),'utf8'),'v1');
  assert.equal(run('--apply').status,0);fs.renameSync(source,source+'-offline');assert.equal(run('--verify').status,0);
  fs.writeFileSync(path.join(app,'modules/demo/core.js'),'manual');assert.notEqual(run('--verify').status,0);
  fs.renameSync(source+'-offline',source);assert.notEqual(run('--apply').status,0);assert.equal(fs.readFileSync(path.join(app,'modules/demo/core.js'),'utf8'),'manual');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
