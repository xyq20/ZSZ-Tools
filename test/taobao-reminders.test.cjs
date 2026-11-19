const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {beijingClock, parseSettings, createTaobaoReminders} = require('../business/taobao-reminders.cjs');

const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/00000000-0000-0000-0000-000000000000';
const settings = {at: '09:05', enabled: true, webhook, recipient: 'ou_fixture'};

test('reminder settings accept Beijing time and a Feishu webhook for a single recipient', () => {
  assert.deepEqual(beijingClock(new Date('2026-11-18T16:05Z')), {day: '2026-11-19', clock: '00:05'});
  assert.deepEqual(parseSettings({...settings, webhook: ''}, settings), settings);
  assert.throws(() => parseSettings({...settings, at: '24:00'}), /配置/);
  assert.throws(() => parseSettings({...settings, webhook: webhook + '?x=1'}), /Webhook/);
  assert.throws(() => parseSettings({...settings, recipient: 'all'}), /用户 ID/);
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
    assert.equal((await tool.runNow()).message, '巡检完成');
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0][2], ['--run-now']);
    assert.equal(runs[0][3].TAOBAO_REMINDER_STATE_DIR, state);
    assert.equal(runs[0][4], undefined);
  });
