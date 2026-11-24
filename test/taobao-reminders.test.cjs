const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {runtimePaths} = require('../business/monthly.cjs');
const {beijingClock, parseSettings, createTaobaoReminders, DEFAULTS_FILE} = require('../business/taobao-reminders.cjs');

const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/00000000-0000-0000-0000-000000000000';
const settings = {at: '09:05', enabled: true, webhook, recipient: 'ou_fixture'};

test('a Mac update preserves older internal reminder defaults in local encrypted storage',
  {skip: process.platform !== 'darwin'}, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-defaults-'));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    const token = 'b'.repeat(32);
    const old = path.join(root, '.toolkit-backup-' + token + '.app', 'Contents/Resources');
    await fs.mkdir(old, {recursive: true});
    await fs.writeFile(path.join(old, DEFAULTS_FILE), JSON.stringify({webhook, recipient: settings.recipient}));
    await fs.mkdir(path.join(root, 'updates'));
    const version = '0.4.34';
    await fs.writeFile(path.join(root, 'updates/pending.json'), JSON.stringify({token, version}));
    const app = {isPackaged: true, getVersion: () => version,
      getPath: key => key === 'exe' ? path.join(root, 'Toolkit.app/Contents/MacOS/Toolkit') : root};
    const safeStorage = {encryptString: s => Buffer.from(Buffer.from(s).toString('base64')),
      decryptString: b => Buffer.from(b.toString(), 'base64').toString()};
    const start = () => createTaobaoReminders({app, safeStorage, resourcesPath: path.join(root, 'new-resources'),
      blocked: () => true, progress: () => {}});
    process.argv.push('--toolkit-update-token=' + token);
    try {
      const tool = start();
      try { assert.equal(tool.status().hasWebhook, true); } finally { tool.stop(); }
    } finally { process.argv.pop(); }
    await fs.unlink(path.join(old, DEFAULTS_FILE));
    const restarted = start();
    try { assert.equal(restarted.status().recipient, settings.recipient); } finally { restarted.stop(); }
    assert(!(await fs.readFile(path.join(root, 'taobao-reminders/defaults.bin'))).includes(webhook));
  });

test('the reminder entry point finds qianniu under isolated Python', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taobao-reminders-import-'));
  t.after(() => fs.rm(stateDir, {recursive: true, force: true}));
  const {python} = runtimePaths({isPackaged: false});
  const script = path.join(__dirname, '../business/taobao-reminders-python/remind.py');
  const result = spawnSync(python, ['-I', '-B', '-X', 'utf8', script, '--dry-run'], {
    cwd: stateDir, env: {...process.env, TAOBAO_REMINDER_STATE_DIR: stateDir},
    encoding: 'utf8', timeout: 20_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), '千牛尚未保存登录状态，请运行 python3 qianniu.py 登录');
});

test('reminder settings accept Beijing time and a Feishu webhook for a single recipient', () => {
  assert.deepEqual(beijingClock(new Date('2026-11-18T16:05Z')), {day: '2026-11-19', clock: '00:05'});
  assert.deepEqual(parseSettings({...settings, webhook: ''}, settings), settings);
  assert.throws(() => parseSettings({...settings, at: '24:00'}), /配置/);
  assert.throws(() => parseSettings({...settings, webhook: webhook + '?x=1'}), /Webhook/);
  assert.throws(() => parseSettings({...settings, recipient: 'all'}), /用户 ID/);
  assert.throws(() => parseSettings({...settings, recipient: 'ALL'}), /用户 ID/);
});

test('toolbox schedule is opt-in, shares no secret with renderer, and preview cannot send', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taobao-reminders-'));
  const args = [];
  const app = {isPackaged: false, getPath: () => root};
  const safeStorage = {isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(Buffer.from(value).toString('base64')),
    decryptString: value => Buffer.from(value.toString(), 'base64').toString()};
  const tool = createTaobaoReminders({
    app, safeStorage, progress: () => {}, blocked: () => false, exclusive: fn => fn(),
    browserFinder: () => 'chrome', now: () => new Date('2026-11-18T02:00Z'),
    runner: async (...call) => { args.push(call); return '巡检完成'; },
  });
  t.after(async () => { tool.stop(); await fs.rm(root, {recursive: true, force: true}); });
  assert.equal(tool.status().enabled, false);
  await assert.rejects(tool.runNow(), /扫码登录/);
  await assert.rejects(tool.save(settings), /扫码登录/);
  const directory = path.join(root, 'taobao-reminders');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'qianniu-auth.json'), '{}');
  await assert.rejects(tool.runNow(), /Webhook/);
  await assert.rejects(tool.save({...settings, recipient: ''}), /用户 ID/);
  await tool.save({...settings, enabled: false, recipient: ''});
  await assert.rejects(tool.runNow(), /用户 ID/);
  const status = await tool.save(settings);
  assert.equal(status.hasWebhook, true);
  assert.equal(JSON.stringify(status).includes(webhook), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(args.length, 1);
  assert.deepEqual(args[0][2], ['--settings-stdin']);
  assert.deepEqual(args[0][4], {webhook, recipient: settings.recipient});
  await tool.save({...settings, webhook: ''});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(args.length, 1);
  await tool.preview();
  assert.deepEqual(args[1][2], ['--dry-run', '--settings-stdin']);
  assert.deepEqual(args[1][4], {recipient: settings.recipient});
  await tool.save({...settings, enabled: false});
  assert.equal((await tool.runNow()).message, '巡检完成');
  assert.deepEqual(args[2][2], ['--run-now', '--settings-stdin']);
  assert.deepEqual(args[2][4], {webhook, recipient: settings.recipient});
});

test('internal defaults work without saved settings and allow local overrides', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taobao-reminders-defaults-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const directory = path.join(root, 'taobao-reminders');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'qianniu-auth.json'), '{}');
  await fs.writeFile(path.join(root, DEFAULTS_FILE), JSON.stringify({webhook, recipient: settings.recipient}));

  const sent = [];
  const options = {
    app: {isPackaged: true, getPath: () => root}, resourcesPath: root,
    safeStorage: {isEncryptionAvailable: () => true, encryptString: Buffer.from,
      decryptString: value => value.toString()},
    progress: () => {}, exclusive: fn => fn(), blocked: () => false,
    browserFinder: () => 'chrome', runner: async (...args) => {sent.push(args[4]); return '巡检完成';},
  };
  const config = path.join(directory, 'settings.bin');
  const preset = {webhook, recipient: settings.recipient};
  const local = {webhook: webhook.replace(/0000$/, '0001'), recipient: 'ou_local'};

  for (const saved of [null, {webhook: '', recipient: ''}, local]) {
    if (saved) await fs.writeFile(config, JSON.stringify({...settings, enabled: false, ...saved}));
    const tool = createTaobaoReminders(options);
    try {
      const expected = saved === local ? local : preset;
      assert.equal(tool.status().enabled, false);
      assert.equal(tool.status().hasWebhook, true);
      assert.equal(tool.status().recipient, expected.recipient);
      assert.equal('webhook' in tool.status(), false);
      await tool.runNow();
      assert.deepEqual(sent.at(-1), expected);
    } finally {
      tool.stop();
    }
  }
});

test('existing Mac background service reads the time set in the toolbox without a second schedule',
  {skip: process.platform !== 'darwin'}, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taobao-native-reminders-'));
    const agents = path.join(root, 'Library', 'LaunchAgents');
    const state = path.join(root, 'Library', 'Application Support', 'TaobaoProductReminders', 'state');
    await fs.mkdir(agents, {recursive: true});
    await fs.mkdir(state, {recursive: true});
    await fs.writeFile(path.join(agents, 'com.linchaoyang.taobao-product-reminders.plist'), 'agent');
    await fs.writeFile(path.join(state, 'reminders.sqlite3'), 'ledger');
    const runs = [];
    const tool = createTaobaoReminders({
      app: {isPackaged: false, getPath: () => root},
      progress: () => {}, blocked: () => false, exclusive: fn => fn(),
      browserFinder: () => 'chrome',
      runner: async (...args) => { runs.push(args); return '巡检完成'; },
    });
    t.after(async () => { tool.stop(); await fs.rm(root, {recursive: true, force: true}); });
    assert.equal(tool.status().nativeAgent, true);
    await assert.rejects(tool.save(settings), /第二个定时/);
    const updated = await tool.save({at: '10:37', enabled: false, webhook: '', recipient: ''});
    assert.equal(updated.at, '10:37');
    assert.equal(updated.enabled, false);
    assert.equal(await fs.readFile(path.join(state, 'schedule-time'), 'utf8'), '10:37\n');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runs.length, 0);
    await fs.writeFile(path.join(state, 'qianniu-auth.json'), '{}');
    await fs.writeFile(path.join(state, 'webhook'), webhook);
    await assert.rejects(tool.runNow(), /用户 ID/);
    const configured = await tool.save({...settings, enabled: false, at: '10:37'});
    assert.equal(configured.recipient, settings.recipient);
    assert.equal(await fs.readFile(path.join(state, 'recipient-id'), 'utf8'), settings.recipient + '\n');
    assert.equal((await fs.stat(path.join(state, 'recipient-id'))).mode & 0o777, 0o600);
    assert.equal((await tool.runNow()).message, '巡检完成');
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0][2], ['--run-now', '--settings-stdin']);
    assert.equal(runs[0][3].TAOBAO_REMINDER_STATE_DIR, state);
    assert.deepEqual(runs[0][4], {webhook: null, recipient: settings.recipient});
  });

test('Mac startup and passive diagnostics leave encrypted reminder defaults untouched', {skip:process.platform!=='darwin'}, async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'toolkit-passive-defaults-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const dir=path.join(root,'taobao-reminders');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir,'defaults.bin'),'encrypted fixture');
  let reads=0;
  const tool=createTaobaoReminders({app:{isPackaged:true,getPath:()=>root},
    safeStorage:{decryptString(){reads++;return JSON.stringify(settings);}},
    resourcesPath:root,blocked:()=>false,progress:()=>{}});
  try {
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(tool.peekStatus().configDeferred,true);
    assert.equal(reads,0);
    assert.equal(tool.status().hasWebhook,true);
    assert.equal(reads,1);
  } finally {tool.stop();}
});
