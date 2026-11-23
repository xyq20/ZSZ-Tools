const assert = require('node:assert/strict');
const {mkdtemp, readFile, rm} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {createErpStockSchedule, parseInterval} = require('../business/erp-stock-schedule.cjs');

const start = Date.UTC(2026, 10, 24, 1, 5);
const minute = 60_000;
const rules = [{number:2, name:'测试规则二', priority:'49', created_at:'2026-01-02 12:00:00'}];

test('supports positive integer seconds, minutes and hours', () => {
  assert.equal(parseInterval('30','seconds').intervalMs, 30_000);
  assert.equal(parseInterval(30,'minutes').intervalMs, 1_800_000);
  assert.equal(parseInterval(1,'hours').intervalMs, 3_600_000);
  for (const value of [0, -1, true, '1.5', '1e2', '9999999999999999']) {
    assert.throws(() => parseInterval(value,'minutes'), /整数/);
  }
  assert.throws(() => parseInterval('1','days'), /间隔/);
});

test('each fixed 30-minute round submits the entire selection and survives an application restart', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'erp-stock-scheduled-'));
  t.after(() => rm(root, {force:true, recursive:true}));
  const file = path.join(root, 'schedule.json');
  let clock = start;
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const jobs = [];
  const selected = [...rules, {number:5, name:'测试规则五', priority:'35', created_at:'2026-01-05 12:00:00'}];
  const results = selected.map(rule => ({number:rule.number,status:'快麦已受理'}));
  const options = {
    file, now: () => clock, notify: () => {},
    execute: async job => {
      jobs.push(job);
      const saved = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(saved.state, 'running');
      await gate;
      return {complete:true, rows:results};
    },
  };
  const configured = createErpStockSchedule(options);
  assert.equal(configured.status(), null);
  assert.equal(configured.schedule(30, 'minutes', selected, 'catalog', 'session').nextAt, start + 30 * minute);
  await configured.runDue();
  assert.deepEqual(jobs, []);

  const restarted = createErpStockSchedule(options);
  clock = start + 30 * minute + 1000;
  const running = restarted.runDue();
  await restarted.runDue();
  const interrupted = createErpStockSchedule(options);
  assert.equal(interrupted.status().state, 'review');
  await interrupted.runDue();
  clock = start + 42 * minute;
  release();
  await running;
  const job = {action:'upload', numbers:[2,5], fingerprint:'catalog', session:'session'};
  assert.deepEqual(jobs, [job]);
  assert.equal(restarted.status().state, 'pending');
  assert.equal(restarted.status().nextAt, start + 60 * minute);
  assert.deepEqual(restarted.status().results, results);
  await createErpStockSchedule(options).runDue();
  assert.equal(jobs.length, 1);
  clock = start + 60 * minute;
  await restarted.runDue();
  assert.deepEqual(jobs, [job,job]);
  assert.equal(restarted.status().nextAt, start + 90 * minute);
});

test('changing an interval restarts timing and a missed round is skipped', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'erp-stock-missed-'));
  t.after(() => rm(root, {force:true, recursive:true}));
  let clock = start;
  const schedule = createErpStockSchedule({file:path.join(root,'schedule.json'), now:() => clock,
    notify:() => {}, execute:() => assert.fail('unexpected scheduled upload')});
  schedule.schedule(30, 'seconds', rules, 'catalog', 'session');
  clock = start + 20_000;
  assert.equal(schedule.updateInterval(2,'minutes').nextAt, start + 140_000);
  clock = start + 30_000;
  await schedule.runDue();
  clock = start + 170_000;
  await schedule.runDue();
  assert.match(schedule.status().message, /已跳过/);
  assert.equal(schedule.status().nextAt, start + 260_000);
  assert.equal(schedule.cancel().state, 'cancelled');
  clock = start + 260_000;
  await schedule.runDue();
  assert.equal(schedule.status().state, 'cancelled');
});

test('a slow batch skips overlapping rounds and resumes at the next fixed slot', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'erp-stock-overlap-'));
  t.after(() => rm(root, {force:true, recursive:true}));
  let clock = start;
  let uploads = 0;
  let finish;
  const gate = new Promise(resolve => {finish = resolve;});
  const schedule = createErpStockSchedule({file:path.join(root,'schedule.json'), now:() => clock,
    notify:() => {}, execute:() => {uploads++;return gate;}});
  schedule.schedule(30, 'seconds', rules, 'catalog', 'session');
  clock = start + 30_000;
  const running = schedule.runDue();
  clock = start + 60_000;
  await schedule.runDue();
  clock = start + 99_000;
  finish({complete:true,rows:[{number:2,status:'快麦已受理'}]});
  await running;
  assert.equal(uploads,1);
  assert.equal(schedule.status().nextAt,start + 120_000);
  clock = start + 120_000;
  await schedule.runDue();
  assert.equal(uploads,2);
});

test('an incomplete or uncertain batch stops future uploads', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'erp-stock-review-'));
  t.after(() => rm(root, {force:true, recursive:true}));
  let clock = start;
  let uploads = 0;
  const schedule = createErpStockSchedule({file:path.join(root,'schedule.json'), now:() => clock,
    notify:() => {}, execute:() => {
      uploads++;
      return {complete:false, rows:[{number:2,status:'结果待核实'}],error:'快麦反馈超时'};
    }});
  schedule.schedule(10, 'seconds', rules, 'catalog', 'session');
  clock = start + 10_000;
  await schedule.runDue();
  assert.equal(schedule.status().state, 'review');
  assert.match(schedule.status().message, /快麦反馈超时/);
  clock = start + 25_000;
  await schedule.runDue();
  assert.equal(uploads, 1);
});

test('stop during an upload preserves the current result and prevents the next round', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'erp-stock-stop-'));
  t.after(() => rm(root, {force:true, recursive:true}));
  let clock = start;
  let finish;
  const gate = new Promise(resolve => {finish = resolve;});
  const schedule = createErpStockSchedule({file:path.join(root,'schedule.json'), now:() => clock,
    notify:() => {}, execute:() => gate});
  schedule.schedule(1, 'seconds', rules, 'catalog', 'session');
  clock += 1000;
  const running = schedule.runDue();
  assert.equal(schedule.cancel().state, 'stopping');
  finish({complete:true, rows:[{number:2,status:'快麦已受理'}]});
  await running;
  assert.equal(schedule.status().state, 'cancelled');
  assert.equal(schedule.status().results[0].status, '快麦已受理');
  clock += 1000;
  assert.equal(schedule.isDue(), false);
});
