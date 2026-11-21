const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {spawnSync}=require('node:child_process');
const {runtimePaths}=require('../business/monthly.cjs');
const {createTaobaoStockTool}=require('../business/taobao-stock.cjs');

class FakeChild extends EventEmitter{
 constructor(report){
  super();
  this.stdout=new EventEmitter();this.stdout.setEncoding=()=>{};
  this.stderr=new EventEmitter();this.stderr.setEncoding=()=>{};
  this.killed=false;this.report=report;this.commands=[];
  this.stdin={write:(line,callback)=>{
   const command=JSON.parse(line);this.commands.push(command);
   if(command.action==='start'){
    fs.mkdirSync(path.dirname(this.report),{recursive:true});
    fs.writeFileSync(this.report,'report');
   }
   const data=command.action==='start'?{status:'completed',job_dir:path.dirname(this.report),
    report_path:this.report,summary:{listed:2,zero_stock:1,skipped:0,failed:0,pending:0,'未匹配款':0}}:
    {message:'命令已完成'};
   setImmediate(()=>{
    this.stdout.emit('data',JSON.stringify({kind:'result',request_id:command.request_id,data})+'\n');
    callback?.(null);
   });
  },end:line=>{
   const command=JSON.parse(line);
   this.commands.push(command);
   setImmediate(()=>this.emit('close',0));
  }};
 }
}

test('stock sync host passes selected workbook and opens the task report',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'toolkit-stock-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const excel=path.join(directory,'inventory.xlsx');fs.writeFileSync(excel,'fixture');
 const report=path.join(directory,'taobao-stock','output','jobs','job','简洁报告.html');
 const child=new FakeChild(report),opened=[],progress=[];
 const tool=createTaobaoStockTool({
  app:{isPackaged:false,getPath:()=>directory},win:{},
  dialog:{showOpenDialog:async()=>({canceled:false,filePaths:[excel]})},
  shell:{openPath:async file=>{opened.push(file);return ''; }},
  progress:message=>progress.push(message),runner:()=>child,
  browserFinder:()=>'/test/chrome',
 });

 assert.equal((await tool.login()).message,'命令已完成');
 assert.equal((await tool.choose()).name,'inventory.xlsx');
 const result=await tool.start();
 assert.match(result.message,/已上架 2/);
 assert.deepEqual(opened,[report]);
 assert.equal(child.commands.find(command=>command.action==='start').excel,excel);
 await tool.cleanup();
 assert.equal(child.commands.at(-1).action,'shutdown');
 assert.ok(progress.includes('正在创建库存同步任务…'));
});

test('stock bridge finds adjacent modules with the bundled Python in isolated mode',t=>{
 const {python}=runtimePaths({isPackaged:false});
 if(!fs.existsSync(python))return t.skip('bundled Python unavailable');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'toolkit-stock-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const script=path.resolve(__dirname,'../business/taobao-stock/bridge.py');
 const result=spawnSync(python,['-I','-B','-X','utf8','-u',script],{
  env:{...process.env,STOCK_DATA_ROOT:directory,STOCK_BROWSER_BIN:'/unused'},
  input:'{"action":"jobs","request_id":"smoke"}\n',encoding:'utf8',timeout:10000
 });
 assert.equal(result.status,0,result.stderr||String(result.error));
 assert.deepEqual(JSON.parse(result.stdout),{kind:'result',request_id:'smoke',data:{jobs:[]}});
});

test('stock login recovers after an unresponsive worker or an exit before pipe closure',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'toolkit-stock-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const hanging=new FakeChild(),exiting=new FakeChild(),healthy=new FakeChild();
 hanging.stdin.write=()=>{};
 hanging.kill=()=>{hanging.killed=true;};
 exiting.stdin.write=()=>setImmediate(()=>exiting.emit('exit',1));
 const children=[hanging,exiting,healthy];
 const tool=createTaobaoStockTool({
  app:{isPackaged:false,getPath:()=>directory},progress:()=>{},
  runner:()=>children.shift(),browserFinder:()=>'/test/chrome',
  loginTimeoutMs:100
 });
 await assert.rejects(tool.login(),/登录响应超时/);
 assert.equal(hanging.killed,true);
 await assert.rejects(tool.login(),/组件启动或运行失败/);
 assert.equal((await tool.login()).message,'命令已完成');
 await tool.cleanup();
});
