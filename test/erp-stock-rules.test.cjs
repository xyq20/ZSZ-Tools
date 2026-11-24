const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const {createErpStockRulesTool} = require('../business/erp-stock-rules.cjs');

test('inventory upload only accepts an explicit, validated selection from the active list', async () => {
  const root = path.join(os.tmpdir(), 'erp-stock-rules-fixture');
  const jobs = [];
  const rules = [
    {number: 1, name: '同名规则', priority: '34', manual_status: '启用'},
    {number: 2, name: '同名规则', priority: '49', created_at: '2026-01-02 10:00:00', manual_status: '启用'},
    {number: 3, name: '禁用规则', priority: '50', manual_status: '禁用'},
  ];
  let response = 0;
  const tool = createErpStockRulesTool({
    app: {getPath: () => root},
    dialog: {showMessageBox: async (_win, options) => {
      assert.match(options.detail, /同名规则（优先级 49 · 2026-01-02 10:00:00）/);
      return {response};
    }},
    getCookies: async () => [],
    progress: () => {},
    runner: async (_paths, job) => {
      jobs.push(job);
      if (job.action === 'list') return {rules, fingerprint: 'fingerprint', session: 'session'};
      return {complete: true, rows: job.numbers.map(number => ({number}))};
    },
  });
  await assert.rejects(tool.upload([2]), /先读取/);
  assert.deepEqual(await tool.list(), rules);
  await assert.rejects(tool.upload([3]), /未启用/);
  await assert.rejects(tool.upload([2, 2]), /有效/);
  assert.equal(await tool.upload([2]), null);
  assert.deepEqual(jobs.map(job => job.action), ['list']);
  await tool.preview([2]);
  response = 1;
  assert.deepEqual(await tool.upload([2]), {complete: true, rows: [{number: 2}]});
  assert.deepEqual(jobs.map(job => [job.action, job.numbers, job.fingerprint, job.session]), [
    ['list', undefined, undefined, undefined], ['preview', [2], 'fingerprint', 'session'], ['upload', [2], 'fingerprint', 'session'],
  ]);
  await assert.rejects(tool.upload([2]), /先读取/);
});

test('a schedule uses the approved rules and never starts an immediate upload', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-stock-approval-'));
  t.after(() => fs.rm(root, {force:true,recursive:true}));
  const rule={number:1,name:'选中规则',priority:'49',manual_status:'启用',created_at:'2026-05-14 14:48:05'};
  const actions=[];
  let response=0;
  const tool=createErpStockRulesTool({
    app:{getPath:()=>root}, getCookies:async()=>[], progress:()=>{},
    dialog:{showMessageBox:async(_win,opts)=>{
      assert.match(opts.message,/每隔 30 分钟 上传所选的 1 条规则/);
      assert.match(opts.detail,/选中规则.*优先级 49/);
      return {response};
    }},
    runner:async(_paths,job)=>{
      actions.push(job.action);
      return {rules:[rule],fingerprint:'catalog',session:'session'};
    },
  });
  await assert.rejects(tool.saveSchedule([1], 30, 'minutes'), /先读取/);
  await tool.list();
  assert.equal(await tool.saveSchedule([1], 30, 'minutes'),null);
  assert.equal(tool.scheduleStatus(),null);
  response=1;
  const saved=await tool.saveSchedule([1], 30, 'minutes');
  assert.equal(saved.state,'pending');
  assert.deepEqual(saved.rules,[rule]);
  assert.equal(saved.session,undefined);
  assert.equal(tool.updateScheduleInterval(5,'minutes').count,5);
  assert.deepEqual(actions,['list']);
  assert.equal(tool.cancelSchedule().state,'cancelled');
});

test('last checked rules survive restart and follow unique enabled identities after reordering', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-stock-selection-'));
  t.after(() => fs.rm(root, {force:true,recursive:true}));
  const first={name:'同名',priority:'34',manual_status:'启用',created_at:'2026-01-02 10:00:00'};
  const retained={...first,priority:'49',created_at:'2026-01-03 10:00:00'};
  const disabled={...first,name:'停用测试'};
  const removed={...first,name:'删除测试'};
  const ambiguous={...first,name:'重复测试'};
  let rules=[first,retained,disabled,removed,ambiguous];
  const makeTool=()=>createErpStockRulesTool({
    app:{getPath:()=>root},getCookies:async()=>[],progress:()=>{},
    runner:async(_paths,job)=>{
      assert.equal(job.action,'list');
      return {rules:rules.map((rule,index)=>({...rule,number:index+1}))};
    },
  });
  const initial=makeTool();
  assert.throws(()=>initial.saveSelection([2]),/先读取/);
  await initial.list();
  initial.saveSelection([2,3,4,5]);
  rules=[retained,first,{...disabled,manual_status:'停用'},ambiguous,ambiguous];
  const restarted=makeTool();
  const refreshed=await restarted.list();
  assert.deepEqual(refreshed.filter(rule=>rule.selected).map(rule=>rule.number),[1]);
  restarted.saveSelection([]);
  assert.equal((await makeTool().list()).some(rule=>rule.selected),false);
});

function limited(numbers, index) {
  const status = position => position < index ? '快麦已受理' : position === index ? '等待重试' : '未处理';
  return {complete:false, retry:{code:'20030013',number:numbers[index],seconds:180},
    rows:numbers.map((number,position)=>({number,status:status(position)}))};
}

async function retryFixture(t, upload, waitForRetry) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-stock-capacity-'));
  t.after(() => fs.rm(root, {force:true,recursive:true}));
  const rules = Array.from({length:7}, (_,index)=>({number:index+1,name:`规则 ${index+1}`,
    priority:String(index+1),manual_status:'启用',created_at:'2026-01-01 00:00:00'}));
  const tool = createErpStockRulesTool({app:{getPath:()=>root},getCookies:async()=>[],progress:()=>{},
    dialog:{showMessageBox:async()=>({response:1})},waitForRetry,
    runner:async(_paths,job)=>{
      if(job.action==='list')return {rules,fingerprint:'catalog',session:'session'};
      assert.equal(job.fingerprint,'catalog');
      assert.equal(job.session,'session');
      return upload(job.numbers);
    },
  });
  await tool.list();
  return {tool, numbers:rules.map(rule=>rule.number)};
}

test('capacity retry waits three minutes per rejection and resumes at the failed rule', async t => {
  const attempts = [];
  const waits = [];
  const {tool,numbers} = await retryFixture(t, pending=>{
    attempts.push(pending);
    if(attempts.length===1)return limited(pending,5);
    if(attempts.length===2)return limited(pending,0);
    return {complete:true,rows:pending.map(number=>({number,status:'快麦已受理'}))};
  }, async ms=>{waits.push(ms);});
  const result=await tool.upload(numbers);
  assert.deepEqual(attempts,[numbers,[6,7],[6,7]]);
  assert.deepEqual(waits,[180000,180000]);
  assert.equal(result.complete,true);
  assert.deepEqual(result.rows,numbers.map(number=>({number,status:'快麦已受理'})));
});

test('stopping a capacity wait keeps prior results and performs no retry', async t => {
  let waiting;
  const ready=new Promise(resolve=>{waiting=resolve;});
  const attempts=[];
  const {tool,numbers}=await retryFixture(t,pending=>{
    attempts.push(pending);
    return limited(pending,5);
  }, (_ms,_value,{signal})=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    waiting();
  }));
  const inProgress=tool.upload(numbers);
  await ready;
  assert.equal(tool.cancelRetry(),true);
  const result=await inProgress;
  assert.equal(result.cancelled,true);
  assert.deepEqual(attempts,[numbers]);
  assert.deepEqual(result.rows.map(row=>row.status),[
    '快麦已受理','快麦已受理','快麦已受理','快麦已受理','快麦已受理','未处理','未处理',
  ]);
  assert.equal(tool.cancelRetry(),false);
});
