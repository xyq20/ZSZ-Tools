const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdir, mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createTaobaoSoutuTool } = require('../business/taobao-soutu.cjs');

test('搜推核对阶段只读，并仅提交再确认且未变动的原分组', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'toolkit-soutu-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, '搜推素材');
  await mkdir(source);
  const itemId = '1096716276168';
  const group = { key: '案例/1', keyword: '案例', images: [1, 2, 3], fingerprint: 'abc' };
  let current = group;
  let confirm = 0;
  let locks = 0;
  let launches = 0;
  let writes = 0;
  const context = new EventEmitter();
  const page = { isClosed: () => false };
  context.pages = () => [page];
  context.close = async () => context.emit('close');
  const core = {
    MaterialPage: class { constructor(page) { this.page = page; } async checkAccess() {} },
    async launchBrowser() { launches++; return context; },
    async scanMaterials() { return [current]; },
    async readState() { return {}; },
    async resolveJobs(_page, jobs) { return jobs.map(entry => ({ ...entry, itemId, title: '核对样例' })); },
    productKey: () => 'state-record',
    async lockRuntime() { locks++; return async () => { locks--; }; },
    async lockPublishSource() { locks++; return async () => { locks--; }; },
    async archivesFor() { return new Map(); },
    async runResolved(options) {
      assert.equal(locks, 2);
      assert.equal(options.resolved[0].itemId, itemId);
      writes++;
      return { completed: 1, archived: [] };
    },
  };
  const tool = createTaobaoSoutuTool({
    app: { getPath: () => directory },
    win: {},
    dialog: {
      showOpenDialog: async () => ({ filePaths: [source] }),
      showMessageBox: async () => ({ response: confirm }),
    },
    progress: () => {},
    coreLoader: async () => core,
    findBrowser: () => 'fixture',
  });
  assert.equal((await tool.choose()).rows[0].count, 3);
  const selection = [{ key: group.key }];
  const plan = await tool.plan(selection);
  assert.equal(plan.ready, true);
  assert.equal(plan.rows[0].itemId, itemId);
  assert.equal(await tool.publish(), null);
  assert.equal(writes, 0);

  confirm = 1;
  current = { ...group, fingerprint: 'changed' };
  await assert.rejects(tool.publish(), /已移动或发生变化/);
  assert.equal(locks, 0);
  assert.equal(writes, 0);
  current = group;
  await tool.plan(selection);
  assert.equal((await tool.publish()).completed, 1);
  assert.equal(writes, 1);
  assert.equal(launches, 1);
  assert.equal(locks, 0);
  await tool.cleanup();
});
