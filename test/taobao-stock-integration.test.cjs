const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
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
  browserFinder:()=>'/test/chrome',probe:()=>({status:0}),
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
