const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {runtimePaths} = require('./monthly.cjs');
const {browserPath} = require('./taobao.cjs');

const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const WEBHOOK = /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const BEIJING = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const INITIAL = {at: '09:05', enabled: false, webhook: '', recipient: ''};
const DEFAULTS_FILE = 'taobao-reminders-defaults.json';
const RETRY_MS = 15 * 60_000;

function beijingClock(now) {
  const [day, clock] = BEIJING.format(now).split(' ');
  return {day, clock};
}

function parseSettings(value, previous = INITIAL, defaults = INITIAL) {
  if (!value || typeof value !== 'object' || typeof value.at !== 'string' ||
      !CLOCK.test(value.at) || typeof value.enabled !== 'boolean' ||
      typeof value.webhook !== 'string' || typeof value.recipient !== 'string') {
    throw Error('请输入有效的北京时间和提醒配置');
  }
  const webhook = value.webhook.trim() || previous.webhook || defaults.webhook;
  const recipient = value.recipient.trim() || defaults.recipient;
  if ((webhook && !WEBHOOK.test(webhook)) || (value.enabled && !webhook)) {
    throw Error('请输入有效的飞书自定义机器人 Webhook');
  }
  if (recipient && (!/^[a-zA-Z0-9_-]{1,100}$/.test(recipient) || recipient.toLowerCase() === 'all')) {
    throw Error('请输入有效的小谭飞书用户 ID');
  }
  return {at: value.at, enabled: value.enabled, webhook, recipient};
}

function feishuDefaults({webhook, recipient}) {
  const settings = parseSettings({...INITIAL, enabled: true, webhook, recipient});
  if (!settings.recipient) throw Error('缺少小谭的飞书用户 ID');
  return {webhook: settings.webhook, recipient: settings.recipient};
}

function runPython(python, script, flags, env, settings) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-B', '-X', 'utf8', '-u', script, ...flags], {
      env: {...process.env, ...env}, windowsHide: true, timeout: 900_000,
      stdio: [settings ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', text => {stdout = (stdout + text).slice(-40_000);});
    child.stderr.setEncoding('utf8').on('data', text => {stderr = (stderr + text).slice(-4000);});
    if (settings) {
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(settings));
    }
    child.on('error', () => reject(Error('无法启动淘宝提醒程序，请检查工具箱安装')));
    child.on('close', code => {
      if (code !== 0) reject(Error(stderr.trim() || '淘宝提醒程序中断，请稍后重试'));
      else resolve(stdout.trim());
    });
  });
}

async function writePrivateFile(file, contents) {
  const temp = file + '.tmp';
  await fsp.writeFile(temp, contents, {mode: 0o600});
  await fsp.rename(temp, file);
}

function createTaobaoReminders({app, safeStorage, progress, exclusive, blocked, runner = runPython,
  browserFinder = browserPath, now = () => new Date(), resourcesPath = process.resourcesPath}) {
  const directory = path.join(app.getPath('userData'), 'taobao-reminders');
  const configFile = path.join(directory, 'settings.bin');
  const legacyRoot = path.join(app.getPath('home'), 'Library', 'Application Support', 'TaobaoProductReminders');
  const nativeAgent = process.platform === 'darwin' &&
    fs.existsSync(path.join(app.getPath('home'), 'Library', 'LaunchAgents', 'com.linchaoyang.taobao-product-reminders.plist')) &&
    fs.existsSync(path.join(legacyRoot, 'state', 'reminders.sqlite3'));
  const stateDir = nativeAgent ? path.join(legacyRoot, 'state') : directory;
  const authFile = path.join(stateDir, 'qianniu-auth.json');
  const nativeTimeFile = path.join(stateDir, 'schedule-time');
  const nativeWebhookFile = path.join(stateDir, 'webhook');
  const nativeRecipientFile = path.join(stateDir, 'recipient-id');
  const scripts = app.isPackaged ? path.join(resourcesPath, 'taobao-reminders-python') :
    path.join(__dirname, 'taobao-reminders-python');
  const python = runtimePaths(app, resourcesPath).python;
  let config = INITIAL;
  let defaults = INITIAL;
  let configError = '';
  let lastResult = '';
  let completedDay = '';
  let retryAfter = 0;
  let active = false;
  let stopped = false;

  if (app.isPackaged) {
    const file = path.join(resourcesPath, DEFAULTS_FILE);
    try {
      if (fs.existsSync(file)) {
        defaults = feishuDefaults(JSON.parse(fs.readFileSync(file, 'utf8')));
        config = {...INITIAL, ...defaults};
      }
    } catch {
      configError = '内置飞书配置无法读取，请重新安装内部版或手动保存配置';
    }
  }
  try {
    if (fs.existsSync(configFile)) {
      if (!safeStorage.isEncryptionAvailable()) throw Error('无法使用系统加密');
      config = parseSettings(JSON.parse(safeStorage.decryptString(fs.readFileSync(configFile))), INITIAL, defaults);
      configError = '';
    }
  } catch {
    configError = '本机提醒配置无法读取，请重新保存配置';
  }

  function status() {
    let at = config.at;
    let recipient = config.recipient;
    if (nativeAgent) {
      at = fs.existsSync(nativeTimeFile) ? fs.readFileSync(nativeTimeFile, 'utf8').trim() : INITIAL.at;
      if (!CLOCK.test(at)) at = INITIAL.at;
      recipient = (fs.existsSync(nativeRecipientFile) ? fs.readFileSync(nativeRecipientFile, 'utf8').trim() : '') || defaults.recipient;
    }
    return {
      enabled: !nativeAgent && config.enabled, at,
      hasWebhook: nativeAgent ? fs.existsSync(nativeWebhookFile) || Boolean(defaults.webhook) : Boolean(config.webhook),
      recipient, hasLogin: fs.existsSync(authFile), nativeAgent,
      message: configError || lastResult,
    };
  }

  async function execute(script, flags = [], settings) {
    const executable = browserFinder();
    if (!executable) throw Error('请先安装 Google Chrome 或 Microsoft Edge');
    return runner(python, path.join(scripts, script), flags, {
      TAOBAO_REMINDER_STATE_DIR: stateDir, TAOBAO_REMINDER_CHROME: executable,
    }, settings);
  }

  async function tick() {
    if (stopped || active || blocked() || nativeAgent || !config.enabled || configError) return;
    const instant = now();
    const {day, clock} = beijingClock(instant);
    if (clock < config.at || day <= completedDay || instant.getTime() < retryAfter) return;
    active = true;
    try {
      const settings = {webhook: config.webhook, recipient: config.recipient};
      lastResult = await exclusive(() => execute('remind.py', ['--settings-stdin'], settings));
      completedDay = day;
      retryAfter = 0;
    } catch (error) {
      retryAfter = now().getTime() + RETRY_MS;
      lastResult = `${error.message}（15 分钟后重试）`;
    } finally {
      active = false;
      progress(lastResult);
    }
  }

  const timer = setInterval(() => { void tick(); }, 15_000);
  timer.unref();
  const initialTick = setImmediate(() => { void tick(); });
  return {
    status,
    async save(value) {
      const next = parseSettings(value, config, defaults);
      if (next.enabled && nativeAgent) throw Error('此 Mac 已有独立巡检程序，避免开启第二个定时');
      if (nativeAgent) {
        await writePrivateFile(nativeRecipientFile, next.recipient + '\n');
        await writePrivateFile(nativeTimeFile, next.at + '\n');
        return status();
      }
      if (next.enabled && !fs.existsSync(authFile)) throw Error('请先扫码登录千牛');
      if (next.enabled && !next.recipient) throw Error('请先配置小谭的飞书用户 ID');
      if (!safeStorage.isEncryptionAvailable()) throw Error('无法使用本机系统加密，请检查系统凭证设置');
      await fsp.mkdir(directory, {recursive: true, mode: 0o700});
      await writePrivateFile(configFile, safeStorage.encryptString(JSON.stringify(next)));
      config = next;
      configError = '';
      lastResult = '';
      retryAfter = 0;
      setImmediate(() => { void tick(); });
      return status();
    },
    async login() {
      progress('请在新开的浏览器中扫码登录 NEIGBORL 钊叔制店铺…');
      const message = await execute('qianniu.py');
      return {...status(), message};
    },
    async preview() {
      progress('正在查询千牛商品创建时间…');
      const message = await execute('remind.py', ['--dry-run', '--settings-stdin'], {recipient: config.recipient});
      return {...status(), message};
    },
    async runNow() {
      const {hasLogin, hasWebhook, recipient} = status();
      if (!hasLogin) throw Error('请先扫码登录千牛');
      if (!nativeAgent && configError) throw Error(configError);
      if (!hasWebhook) throw Error('请先配置飞书机器人 Webhook');
      if (!recipient) throw Error('请先配置小谭的飞书用户 ID');
      const {day} = beijingClock(now());
      progress('正在查询千牛商品，完成后将发送飞书消息…');
      lastResult = nativeAgent
        ? await execute('remind.py', ['--run-now', '--settings-stdin'], {
          webhook: fs.existsSync(nativeWebhookFile) ? null : defaults.webhook, recipient,
        })
        : await execute('remind.py', ['--run-now', '--settings-stdin'], {
          webhook: config.webhook, recipient: config.recipient,
        });
      completedDay = day;
      retryAfter = 0;
      return {...status(), message: lastResult};
    },
    stop() { stopped = true; clearInterval(timer); clearImmediate(initialTick); },
  };
}

module.exports = {createTaobaoReminders, beijingClock, parseSettings, feishuDefaults, DEFAULTS_FILE};
