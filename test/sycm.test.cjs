const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createSycmTool,validateOptions}=require('../business/sycm.cjs');
test('sycm accepts supported modes and passes names as literal arguments',()=>{
 assert.throws(()=>validateOptions({mode:'shell'}));assert.throws(()=>validateOptions({color:'red'}));
 assert.deepEqual(validateOptions({mode:'flow',name:'$test,商品'}),['--mode','flow','--color','粉,紫,黄,蓝','--name','$test,商品']);
});
test('sycm starts a fresh copy, persists resume across restart and respects incomplete exit',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sycm-test-')),file=path.join(dir,'原表.xlsx');await fs.writeFile(file,'original');let failure=true,opened,runDir;
 const options={app:{isPackaged:false,getPath:()=>dir},win:{},dialog:{showOpenDialog:async()=>({filePaths:[file]})},shell:{openPath:async p=>{opened=p;return '';}},progress:()=>{},chromeFinder:async()=>'/chrome',runner:async(python,args,env)=>{
  if(args.includes('-c'))return {code:0,tail:''};
  const copy=path.join(env.SYCM_DATA_DIR,'原表.xlsx');assert.notEqual(copy,file);
  if(args.includes('--resume')){assert.equal(env.SYCM_DATA_DIR,runDir);assert.equal(await fs.readFile(copy,'utf8'),'partial');assert(args.includes('flow'));}else{runDir=env.SYCM_DATA_DIR;assert.equal(await fs.readFile(copy,'utf8'),'original');}
  const out=path.join(env.SYCM_DATA_DIR,'output/sycm');await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'progress.json'),JSON.stringify({stage:failure?'incomplete':'done',ok:1,fail:failure?1:0,skipped:0,index:2,total:2}));
  await fs.writeFile(copy,failure?'partial':'complete');return {code:failure?1:0,tail:'本次结束'};
 }};
 try{
  const tool=createSycmTool(options);await assert.rejects(tool.start({}),/选择/);await assert.rejects(tool.resume(),/没有可继续/);await tool.choose();
  const first=await tool.start({mode:'flow'});assert.equal(first.incomplete,true);assert.equal(await fs.readFile(file,'utf8'),'original');
  failure=false;const restarted=createSycmTool(options);await restarted.results();assert.equal(opened,first.directory);
  const second=await restarted.resume();assert.equal(second.directory,first.directory);assert.equal(second.incomplete,false);assert.equal(await fs.readFile(second.file,'utf8'),'complete');
  await restarted.choose();const third=await restarted.start({});assert.notEqual(third.directory,first.directory);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
