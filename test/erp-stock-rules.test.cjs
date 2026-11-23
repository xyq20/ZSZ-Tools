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
