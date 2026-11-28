const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdir, mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createTaobaoSoutuTool } = require('../business/taobao-soutu.cjs');

test('Windows 搜推专用浏览器重开时在首次导航前恢复已加密的千牛会话', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'toolkit-soutu-login-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cookie = { name: 'fixture-login', value: 'fixture-session', domain: '.taobao.com', path: '/', expires: -1 };
  const file = path.join(directory, 'taobao-soutu', 'session-cookies.bin');
  const contexts = [];
  function createTool() {
    return createTaobaoSoutuTool({
      app: { getPath: () => directory },
      platform: 'win32',
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: value => Buffer.from(Buffer.from(value).toString('base64')),
        decryptString: bytes => Buffer.from(bytes.toString(), 'base64').toString(),
      },
      progress: message => assert.fail(message),
      findBrowser: () => 'fixture',
      coreLoader: async () => ({
        MaterialPage: class {
          constructor(page) { this.page = page; }
          async checkAccess() {
            if (!this.page.url().includes('myseller.taobao.com')) throw Error('会话未登录或已过期');
          }
          async enter() {}
        },
        async launchBrowser() {
          let url = 'about:blank';
          const page = new EventEmitter();
          const frame = { url: () => url };
          const cookies = [];
          const navigate = next => {
            url = next;
            page.emit('framenavigated', frame);
          };
          page.url = frame.url;
          page.mainFrame = () => frame;
          page.isClosed = () => false;
          page.bringToFront = async () => {};
          page.goto = async target => navigate(cookies.length ? target : 'https://login.taobao.com');
          const context = new EventEmitter();
          context.pages = () => [page];
          context.cookies = async () => cookies;
          context.addCookies = async restored => cookies.push(...restored);
          context.close = async () => context.emit('close');
          contexts.push({ cookies, navigate, context });
          return context;
        },
      }),
    });
  }

  const first = createTool();
  t.after(() => first.cleanup());
  assert.match((await first.login()).message, /请在专用浏览器中登录/);
  contexts[0].cookies.push(cookie);
  contexts[0].navigate('https://myseller.taobao.com/home.htm');
  await first.cleanup();
  assert(!(await readFile(file)).includes(Buffer.from(cookie.value)));

  const restarted = createTool();
  t.after(() => restarted.cleanup());
  assert.match((await restarted.login()).message, /素材中心已就绪/);
  assert.deepEqual(contexts[1].cookies, [cookie]);
  assert.equal(contexts.length, 2);
});

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
  let waitForConfirmation = false;
  let unmatched;
  let fixtureState = {};
  const snapshots = [];
  const context = new EventEmitter();
  const page = { isClosed: () => false };
  context.pages = () => [page];
  context.close = async () => context.emit('close');
  const core = {
    MaterialPage: class { constructor(page) { this.page = page; } async checkAccess() {} },
    async launchBrowser() { launches++; return context; },
    async scanMaterials() { return unmatched ? [current, unmatched] : [current]; },
    async readState() { return fixtureState; },
    async resolveJobs(_page, jobs, options) {
      assert.equal(options.getModelKey(), 'test-key');
      return jobs.filter(({ group }) => {
        if (group !== unmatched) return true;
        options.onUnmatched({ group, error: Error('候选主图暂未读到') });
        return false;
      }).map(entry => ({ ...entry, itemId, title: '核对样例', matchedBy: 'deepseek', matchReason: '口袋细节吻合' }));
    },
    productKey: () => 'state-record',
    async lockRuntime() { locks++; return async () => { locks--; }; },
    async lockPublishSource() { locks++; return async () => { locks--; }; },
    async archivesFor() { return new Map(); },
    async runResolved(options) {
      assert.equal(locks, 2);
      assert.equal(options.resolved[0].itemId, itemId);
      options.onBatch?.('正在回查发布结果', 'active');
      writes++;
      if (waitForConfirmation) throw Object.assign(new Error('提交结果待核对'), { code: 'SOUTU_PENDING' });
      options.state['state-record'] = { status: 'published' };
      options.onBatch?.('千牛已确认发布', 'active');
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
    progress: (_message, snapshot) => { if (snapshot) snapshots.push(snapshot); },
    getModelKey: () => 'test-key',
    coreLoader: async () => core,
    findBrowser: () => 'fixture',
  });
  assert.equal((await tool.choose()).rows[0].count, 3);
  const selection = [{ key: group.key }];
  const plan = await tool.plan(selection);
  assert.equal(plan.ready, true);
  assert.equal(plan.rows[0].itemId, itemId);
  assert.deepEqual(snapshots.map(({ operation, count, total, stage }) => [operation, count, total, stage]), [
    ['check', 0, 1, 'active'], ['check', 0, 1, 'active'], ['check', 1, 1, 'active'], ['check', 1, 1, 'done'],
  ]);
  assert.equal(snapshots.find(snapshot => snapshot.stage === 'active' && snapshot.count === 1)?.rows?.[0]?.status,
    '核对通过（DeepSeek）');
  assert.equal(plan.rows[0].matchReason, '口袋细节吻合');
  const eventsBeforeCancel = snapshots.length;
  assert.equal(await tool.publish(), null);
  assert.equal(snapshots.length, eventsBeforeCancel);
  assert.equal(writes, 0);

  confirm = 1;
  current = { ...group, fingerprint: 'changed' };
  await assert.rejects(tool.publish(), /已移动或发生变化/);
  assert.deepEqual([snapshots.at(-1)?.stage, snapshots.at(-1)?.count], ['error', 0]);
  assert.equal(locks, 0);
  assert.equal(writes, 0);
  current = group;
  await tool.plan(selection);
  assert.equal((await tool.publish()).completed, 1);
  assert.deepEqual([snapshots.at(-1)?.stage, snapshots.at(-1)?.count], ['done', 1]);
  assert.equal(writes, 1);
  assert.equal(launches, 1);
  assert.equal(locks, 0);
  fixtureState = {};
  waitForConfirmation = true;
  await tool.plan(selection);
  await assert.rejects(tool.publish(), /提交结果待核对/);
  assert.deepEqual([snapshots.at(-1)?.stage, snapshots.at(-1)?.count], ['pending', 0]);

  unmatched = { key: '案例/2', keyword: '案例', images: [4, 5, 6], fingerprint: 'def' };
  await tool.scan();
  const twoGroups = [...selection, { key: unmatched.key }];
  fixtureState = {};
  const partial = await tool.plan(twoGroups);
  assert.equal(partial.ready, true);
  assert.equal(partial.matched, 1);
  assert.equal(snapshots.at(-1).stage, 'partial');
  fixtureState = { previous: { status: 'pending', group: '另一款/1' } };
  const blocked = await tool.plan(twoGroups);
  assert.equal(blocked.ready, false);
  assert.equal(blocked.pending, '另一款/1');
  assert.equal(blocked.matched, 1);
  assert.equal(snapshots.at(-1).stage, 'pending');
  await tool.cleanup();
});

test('Mac 搜推用专用 Chrome 恢复会话，打开和退出均不访问工具箱钥匙串', {
  skip: process.platform !== 'darwin' || !require('node:fs').existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'soutu-chrome-session-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const {launchBrowser} = await import('../modules/taobao-soutu/browser.mjs');
  const runtime = path.join(directory,'taobao-soutu');
  await mkdir(runtime);
  await require('node:fs/promises').writeFile(path.join(runtime,'session-cookies.bin'),'old encrypted fixture');
  let ctx, accesses=0;
  for(let n=0;n<2;n++){
    const tool=createTaobaoSoutuTool({
      app:{getPath:()=>directory}, platform:'darwin', progress:()=>{},
      safeStorage:new Proxy({}, {get(){accesses++;throw Error('unexpected Keychain access');}}),
      findBrowser:()=>'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      coreLoader:async()=>({
        async launchBrowser(root,config){
          ctx=await launchBrowser(root,config);
          await ctx.route('**/*',route=>route.fulfill({body:'fixture'}));
          return ctx;
        },
        MaterialPage:class {constructor(page){this.page=page;} async checkAccess(){} async enter(){}}
      })
    });
    try{
      await tool.login();
      if(n===0)await ctx.addCookies([{name:'fixture',value:'test',domain:'localhost',path:'/',expires:-1,httpOnly:true}]);
      else assert((await ctx.cookies()).some(cookie=>cookie.name==='fixture'&&cookie.expires===-1));
    }finally{await tool.cleanup();}
  }
  assert.equal(accesses,0);
});
