'use strict';
// Read-only diagnostics for the home overview and the ops page.
// Never require('electron') here: Electron objects are injected so that plain
// `node --test` can exercise every probe with stand-ins. Nothing in
// createDiagnostics writes, spawns, decrypts, opens a browser or uses the
// network; the only write in this module is createActivity's failure log.
const nodePath = require('node:path');

const KB = 1024, MB = 1024 * KB;
// Taobao history.json and soutu publish-state.json only ever grow and the business side reads them whole with no
// cap, so this is a cost bound, not a validity rule: a larger file is reported as unchecked, never as broken.
const STATE_MAX_BYTES = 16 * MB;
const TOOL_PREFIXES = ['erp-stock-rules', 'taobao-reminders', 'taobao-stock', 'taobao-soutu', 'return-rate', 'monthly', 'report', 'price', 'sycm', 'taobao'];
const TOOL_KEYS = ['report', 'price', 'monthly', 'return-rate', 'taobao', 'taobao-reminders', 'taobao-stock', 'sycm', 'taobao-soutu'];
const QUIET_SUCCESS = new Set(['return-rate-status', 'taobao-reminders-status']);
const ERP_DOMAIN = /(^|\.)(superboss\.cc|kuaimai\.com)$/;
const JOB_NAME = /^\d{8}_\d{6}_[0-9a-f]{8}$/;
const RUN_NAME = /^\d{4}-\d{2}-\d{2}-/;
const FINAL_JOB_STATUSES = new Set(['completed', 'completed_with_exceptions', 'failed']);
const TAOBAO_STATUSES = new Set(['published', 'submitted', 'unknown']);
const SOUTU_STATUSES = new Set(['pending', 'published']);
const COMPONENTS = [
  ['monthly', 'monthly-python/bridge.py'],
  ['return-rate', 'return-rate-python/bridge.py'],
  ['sycm', 'sycm-python/run.py'],
  ['taobao-reminders', 'taobao-reminders-python/remind.py'],
  ['taobao-stock', 'taobao-stock/bridge.py'],
  ['erp-stock-rules', 'erp-stock-rules-python/bridge.py'],
];

// ---------------------------------------------------------------- toolOf
function toolOf(action) {
  const name = String(action ?? '');
  if (name === 'choose') return 'price';
  if (name === 'login') return '';
  for (const prefix of TOOL_PREFIXES) if (name === prefix || name.startsWith(prefix + '-')) return prefix;
  return '';
}

// ---------------------------------------------------------------- redaction
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Any account's home directory is personal data, including Windows 8.3 short names (C:\Users\ADMINI~1), user names
// with spaces and JSON-escaped separators; Shared, Public and Default folders are left alone. Same rules in app/ui.js.
const HOME_RULES = [
  [/\b[A-Za-z]:[\\/]{1,3}Users[\\/]{1,3}(?!(?:Public|Default|All Users)(?:[\\/]|$))[^\\/\s"'<>，。；：、（）]+(?:(?: [^\\/\s"'<>，。；：、（）]+){1,4}(?=[\\/]))?/gi, '~'],
  [/(?<![\w.~-])\\?\/(?:Users|home)\\?\/(?!(?:Shared|Public|Guest)(?:\\?\/|$))[^\\/\s"'<>，。；：、（）]+(?:(?: [^\\/\s"'<>，。；：、（）]+){1,4}(?=[\\/]))?/g, '~'],
];
// Every pattern is linear: key names are anchored at an identifier start and bounded, so no input can make them backtrack.
const RULES = [
  [/(?:https?:(?:\\{0,2}\/){2})?(?:open\.(?:feishu\.cn|larksuite\.com))?\\{0,2}\/open-apis\\{0,2}\/bot\\{0,2}\/v2\\{0,2}\/hook\\{0,2}\/[\w-]+/gi, '[飞书Webhook已隐藏]'],
  [/\b((?:proxy-)?authorization)["']?\s*[:=][^\r\n]*/gi, '$1=[已隐藏]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐藏]'],
  [/\bBasic\s+([A-Za-z0-9+/]{6,}={0,2})/gi, (match, token) => /[\d=]/.test(token) || (/[a-z]/.test(token) && /[A-Z]/.test(token)) ? 'Basic [已隐藏]' : match],
  [/\b(?:set-)?cookie["']?\s*[:=][^\r\n]*/gi, 'cookie=[已隐藏]'],
  [/\b(cookie2|unb|sgcookie|_m_h5_tk(?:_enc)?|skt|csg|uc[134]|lgc|tracknick|_nk_|cna|isg|tfstk|x5sec)=[^;\s"']+/g, '$1=[已隐藏]'],
  [/("name"\s*:\s*"[^"\r\n]{1,64}"\s*,\s*"value"\s*:\s*)"[^"\r\n]*"/g, '$1"[已隐藏]"'],
  [/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-[已隐藏]'],
  [/\b(ou|on|oc)_[0-9A-Za-z]{8,}/g, '$1_[已隐藏]'],
  [/(["']?)(?<![\w-])([\w-]{0,64}?(?:token|secret|passw(?:or)?d|pwd|session(?:_?id|_?key)?|api[-_]?key|access[-_]?key|app[-_]?key|webhook|credential)(?:[-_]?(?:id|key|url|value|str))?_?)(?![\w-])\1\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"',;}&]+)/gi, '$2=[已隐藏]'],
  [/(?<!\d)(?:\+?86[- ]?)?(1[3-9]\d)[- ]?\d{4}[- ]?(\d{4})(?!\d)/g, '$1****$2'],
  [/[A-Za-z0-9+/_=-]{40,}/g, match => /[A-Z]/.test(match) && /[a-z]/.test(match) && /\d/.test(match) ? '[长串已隐藏]' : match],
];

function homePatterns(home, platform) {
  if (typeof home !== 'string') return [];
  const trimmed = home.replace(/[\\/]+$/, '');
  if (trimmed.length < 2) return [];
  const variants = new Set([trimmed]);
  variants.add(trimmed.replace(/\//g, '\\/')); // JSON-escaped separators
  if (platform === 'win32') {
    variants.add(trimmed.replace(/\\/g, '/'));
    variants.add(trimmed.replace(/\//g, '\\'));
    variants.add(trimmed.replace(/[\\/]/g, '\\\\'));
  }
  // Longest first so an escaped variant is not half-replaced by a shorter one.
  return [...variants].sort((a, b) => b.length - a.length)
    .map(value => new RegExp(escapeRegExp(value) + '(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_])', platform === 'win32' ? 'gi' : 'g'));
}

function createRedactor({home, platform = process.platform} = {}) {
  const homes = homePatterns(home, platform);
  return function redact(text, limit = 300) {
    let value = text == null ? '' : String(text);
    for (const pattern of homes) value = value.replace(pattern, '~');
    for (const [pattern, replacement] of HOME_RULES) value = value.replace(pattern, replacement);
    for (const [pattern, replacement] of RULES) value = value.replace(pattern, replacement);
    if (Number.isFinite(limit) && limit > 0 && value.length > limit) value = value.slice(0, Math.max(0, limit - 1)) + '…';
    return value;
  };
}

// ---------------------------------------------------------------- small helpers
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const attempt = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
function iso(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
const isoText = value => iso(value) ?? (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+/.test(value) ? value.slice(0, 40) : null);
const mtimeOf = info => info ? iso(info.mtimeMs ?? info.mtime) : null;
const numberOrNull = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const baseName = value => String(value ?? '').split(/[\\/]/).pop();
const compareVersions = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};
function waitUpTo(promise, ms, fallback) {
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Read helpers over an injected fs/promises-compatible object. Reads only.
function fileReader(fs) {
  const decoder = new TextDecoder('utf-8');
  const fail = (message, code) => Object.assign(Error(message), {code});
  async function stat(file) { try { return await fs.stat(file); } catch { return null; } }
  async function list(directory, withTypes = false) {
    try { return await fs.readdir(directory, withTypes ? {withFileTypes: true} : undefined); } catch { return []; }
  }
  async function readRange(file, maxBytes, fromEnd) {
    const handle = await fs.open(file, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw fail('不是文件', 'ENOTFILE');
      if (!fromEnd && info.size > maxBytes) throw fail('文件过大', 'ETOOBIG');
      const length = Math.min(info.size, maxBytes), start = info.size - length;
      const bytes = new Uint8Array(length);
      let offset = 0;
      while (offset < length) {
        const {bytesRead} = await handle.read(bytes, offset, length - offset, start + offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      let text = decoder.decode(bytes.subarray(0, offset));
      if (fromEnd && start > 0) {
        // Drop the partial first line (it may also hold a split UTF-8 sequence).
        const cut = text.indexOf('\n');
        text = cut >= 0 ? text.slice(cut + 1) : '';
      }
      return {text, info};
    } finally {
      try { await handle.close(); } catch {}
    }
  }
  return {
    stat, list,
    readText: async (file, maxBytes) => (await readRange(file, maxBytes, false)).text,
    // Also returns the stat of the handle that was read, so a cache key always matches the bytes parsed.
    readTextInfo: (file, maxBytes) => readRange(file, maxBytes, false),
    readTail: async (file, maxBytes) => (await readRange(file, maxBytes, true)).text,
    readJson: async (file, maxBytes) => JSON.parse((await readRange(file, maxBytes, false)).text),
  };
}

// ---------------------------------------------------------------- activity
const processStartedAt = new Date(Date.now() - process.uptime()*1000).toISOString();

function createActivity({directory, redact = createRedactor(), persist = true, limit = 40, maxBytes = 256 * KB,
  fs = require('node:fs/promises')} = {}) {
  const entries = [];
  const enabled = Boolean(persist && directory);
  const file = directory ? nodePath.join(directory, 'toolkit-errors.log') : null;
  const previous = directory ? nodePath.join(directory, 'toolkit-errors.1.log') : null;
  const io = fileReader(fs);
  const clean = (text, max) => { try { return redact(text, max); } catch { return ''; } };
  let queue = Promise.resolve();

  async function append(line) {
    await fs.mkdir(directory, {recursive: true, mode: 0o700});
    const info = await io.stat(file);
    if (info && info.size > maxBytes) await fs.rename(file, previous);
    await fs.appendFile(file, line, {mode: 0o600});
  }

  // Never receives IPC arguments: callers pass only names, outcome and timing.
  function record({action, tool, ok, ms, error, step, code} = {}) {
    try {
      const name = String(action ?? '').slice(0, 80);
      if (ok && QUIET_SUCCESS.has(name)) return;
      const entry = {at: new Date().toISOString(), action: name, tool: String(tool ?? '').slice(0, 40), ok: Boolean(ok),
        ms: typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : null};
      if (!entry.ok) {
        entry.id = require('node:crypto').randomUUID();
        entry.error = clean(error == null ? '' : String(error), 300);
        if (step) entry.step = clean(step,180);
        if (code != null) entry.code = clean(String(code),64);
      }
      entries.push(entry);
      if (entries.length > limit) entries.splice(0, entries.length - limit);
      if (!entry.ok && enabled) {
        const {error: message, ok: ignored, ...fields} = entry;
        const line = JSON.stringify({...fields, message}) + '\n';
        queue = queue.then(() => append(line)).catch(() => {});
      }
    } catch {}
  }

  const recent = () => entries.slice().reverse().map(entry => ({...entry}));
  const memoryErrors = () => entries.filter(entry => !entry.ok).reverse().slice(0, 30)
    .map(({ok, error, ...fields}) => ({...fields, message: error ?? ''}));
  function parse(text) {
    const result = [];
    for (const line of text.split(/\r?\n/).reverse()) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        const at = isObject(value) ? iso(value.at) : null;
        if (!at) continue;
        result.push({at, action: String(value.action ?? '').slice(0, 80), tool: String(value.tool ?? '').slice(0, 40),
          id: clean(value.id,64), step:clean(value.step,180), code:clean(value.code,64),
          ms: Number.isFinite(value.ms) ? value.ms : null, message: clean(String(value.message ?? ''), 300)});
      } catch {}
    }
    return result;
  }
  async function errors() {
    if (!enabled) return memoryErrors();
    await waitUpTo(queue, 200);
    let current;
    try { current = parse(await io.readTail(file, 32 * KB)); } catch { return memoryErrors(); }
    if (current.length < 30) {
      try { current.push(...parse(await io.readTail(previous, 32 * KB))); } catch {}
    }
    return current.slice(0, 30);
  }

  return {record, recent, errors, flush: () => queue};
}

// ---------------------------------------------------------------- read-only IPC
function registerReadOnly({ipcMain, win, redact = createRedactor()}, name, fn) {
  ipcMain.handle(name, async event => {
    // isDestroyed first: touching webContents of a destroyed window throws.
    if (!win || win.isDestroyed() || !event || event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame) throw Error('非法调用来源');
    try {
      return {ok: true, data: await fn()};            // renderer arguments are ignored on purpose
    } catch (error) {
      let message;
      try { message = redact(error?.message ?? String(error)); } catch { message = '读取失败'; }
      return {ok: false, error: message};
    }
  });
}

// ---------------------------------------------------------------- diagnostics
function createDiagnostics({app, safeStorage, sessions = {}, passiveCredentials = false, loginReady, ensureLoginReady = () => loginReady, reminders, getRunning = () => null, activity,
  redact, fs = require('node:fs/promises'), os = require('node:os'), proc = process,
  runtimePaths, browserPath, componentsRoot, timeoutMs = 1500, loginWaitMs = 800, stateMaxBytes = STATE_MAX_BYTES} = {}) {
  const clean = typeof redact === 'function' ? redact : createRedactor({home: attempt(() => app.getPath('home'))});
  const io = fileReader(fs);
  const parseCache = new Map();
  let loginSettledPromise;
  const resolveRuntimePaths = () => runtimePaths || require('./monthly.cjs').runtimePaths;
  const resolveBrowserPath = () => browserPath || require('./taobao.cjs').browserPath;

  const encryption = () => passiveCredentials ? null : attempt(() => Boolean(safeStorage.isEncryptionAvailable()), null);

  async function loginReadyWithin(ms) {
    loginSettledPromise ??= Promise.resolve().then(ensureLoginReady).then(() => true, () => true);
    return waitUpTo(loginSettledPromise, ms, false);
  }

  // Only a boolean leaves this function: no cookie names, values or counts.
  async function cookieEvidence(partition) {
    if (!partition?.cookies || typeof partition.cookies.get !== 'function') return null;
    if (!await loginReadyWithin(loginWaitMs)) return null;
    const cookies = await partition.cookies.get({});
    if (!Array.isArray(cookies)) return null;
    return cookies.some(cookie => ERP_DOMAIN.test(String(cookie?.domain ?? '').replace(/^\./, '')));
  }

  async function pythonInfo(withVersion) {
    let file;
    try { file = resolveRuntimePaths()(app).python; } catch { return {ok: null, version: null}; }
    if (typeof file !== 'string' || !file) return {ok: null, version: null};
    const ok = Boolean(await io.stat(file));
    if (!withVersion || !ok) return {ok, version: null};
    let version = null;
    if (proc.platform === 'win32') {
      const found = (await io.list(nodePath.dirname(file))).map(name => /^python3(\d+)\._pth$/i.exec(String(name)))
        .filter(Boolean).map(match => '3.' + Number(match[1])).sort(compareVersions);
      version = found.pop() ?? null;
    } else {
      const match = /python(\d+\.\d+)$/.exec(nodePath.basename(file));
      version = match ? match[1] : null;
    }
    return {ok, version};
  }

  async function browserInfo(withVersion) {
    let executable = null;
    try { executable = resolveBrowserPath()() || null; } catch {}
    if (typeof executable !== 'string' || !executable) return {ok: false, name: null, version: null};
    const base = baseName(executable);
    const name = /edge/i.test(base) ? 'Microsoft Edge' : /chrome/i.test(base) ? 'Google Chrome' : null;
    if (!withVersion) return {ok: true, name, version: null};
    let version = null;
    if (proc.platform === 'darwin') {
      const at = executable.indexOf('.app/');
      if (at > 0) {
        try {
          const plist = await io.readText(nodePath.join(executable.slice(0, at + 4), 'Contents', 'Info.plist'), 512 * KB);
          const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]{1,40})<\/string>/.exec(plist);
          version = match ? match[1].trim() : null;
        } catch {}
      }
    } else if (proc.platform === 'win32') {
      const found = (await io.list(nodePath.dirname(executable))).map(String)
        .filter(entry => /^\d+\.\d+\.\d+\.\d+$/.test(entry)).sort(compareVersions);
      version = found.pop() ?? null;
    }
    return {ok: true, name, version};
  }

  async function components() {
    const root = componentsRoot ?? (app.isPackaged ? proc.resourcesPath : __dirname);
    return Promise.all(COMPONENTS.map(async ([id, relative]) =>
      ({id, ok: Boolean(root) && Boolean(await io.stat(nodePath.join(root, ...relative.split('/'))))})));
  }

  async function envProbe() {
    const [python, browser, parts] = await Promise.all([pythonInfo(false), browserInfo(false), components()]);
    const missing = parts.filter(part => !part.ok).map(part => part.id);
    return {encryption: encryption(), python: python.ok, browser: {name: browser.name}, components: {ok: missing.length === 0, missing}};
  }

  async function lastPreview(ctx) {
    const root = ctx.at('monthly-runs');
    const names = (await io.list(root, true)).filter(entry => entry.isDirectory() && RUN_NAME.test(entry.name))
      .map(entry => entry.name).sort().reverse().slice(0, 60);
    let best = null;
    for (const [name, info] of await Promise.all(names.map(async name => [name, await io.stat(nodePath.join(root, name))]))) {
      if (info && (!best || info.mtimeMs > best.info.mtimeMs)) best = {name, info};
    }
    return best ? {node: best.name.slice(0, 10), at: mtimeOf(best.info)} : null;
  }

  // Parsed results are cached per file version. ino is in the key because the business writes these files via
  // temp + rename: a status flip such as submitted -> published keeps the size, and mtime alone can be coarse.
  const cacheKey = (file, info) => `${file}\n${info.ino ?? ''}\n${info.mtimeMs}\n${info.size}`;
  function remember(key, value) {
    parseCache.set(key, value);
    while (parseCache.size > 64) parseCache.delete(parseCache.keys().next().value);
  }

  // Returns {missing} | {unchecked} | {invalid} | {value}. Only a structure the business would reject (or a file that
  // cannot be read) is invalid; a valid file over stateMaxBytes is unchecked. summarize() keeps only small counts, so
  // a large journal is parsed once per version and the parsed object is never retained.
  async function summarizeState(file, summarize) {
    let info;
    try { info = await fs.stat(file); } catch (error) { return error?.code === 'ENOENT' ? {missing: true} : {invalid: true}; }
    if (!info.isFile()) return {invalid: true};
    if (info.size > stateMaxBytes) return {unchecked: true};
    const cached = parseCache.get(cacheKey(file, info));
    if (cached) return cached;
    let read;
    try { read = await io.readTextInfo(file, stateMaxBytes); } catch (error) {
      // The file may be replaced between stat and open; read errors are not cached.
      if (error?.code === 'ENOENT') return {missing: true};
      return error?.code === 'ETOOBIG' ? {unchecked: true} : {invalid: true};
    }
    let value = null;
    try { value = summarize(JSON.parse(read.text)); } catch {}
    const result = isObject(value) ? {value} : {invalid: true};
    remember(cacheKey(file, read.info), result);
    return result;
  }

  // Mirrors readState in modules/taobao/scripts/state.js.
  function countTaobao(state) {
    if (!isObject(state) || !isObject(state.records) || !Array.isArray(state.captions)) return null;
    const counts = {published: 0, submitted: 0, unknown: 0};
    for (const record of Object.values(state.records)) {
      if (!isObject(record) || !TAOBAO_STATUSES.has(record.status) || typeof record.file !== 'string' || typeof record.at !== 'string') return null;
      counts[record.status]++;
    }
    return counts;
  }

  async function taobaoProbe(ctx) {
    const [profile, cookies, key, state] = await Promise.all([
      io.stat(ctx.at('taobao', 'browser-profile')), io.stat(ctx.at('taobao', 'session-cookies.bin')),
      io.stat(ctx.at('taobao', 'model-key.bin')), summarizeState(ctx.at('taobao', 'history.json'), countTaobao)]);
    const records = state.value ? {...state.value} : state.missing ? {published: 0, submitted: 0, unknown: 0} : null;
    return {login: {evidence: Boolean(profile), at: mtimeOf(cookies) ?? mtimeOf(profile)}, hasKey: Boolean(key),
      records, recordsError: Boolean(state.invalid), recordsUnchecked: Boolean(state.unchecked)};
  }

  // reminders.status() only reads files; recipient itself is never returned.
  function remindersProbe() {
    const status = passiveCredentials && reminders.peekStatus ? reminders.peekStatus() : reminders.status();
    if (!isObject(status)) throw Error('读取失败');
    const message = status.message == null ? '' : String(status.message);
    return {hasLogin: Boolean(status.hasLogin), ...(status.configDeferred ? {configDeferred:true} : {}), hasWebhook: Boolean(status.hasWebhook), hasRecipient: Boolean(status.recipient),
      enabled: Boolean(status.enabled), at: typeof status.at === 'string' && /^\d{2}:\d{2}$/.test(status.at) ? status.at : null,
      nativeAgent: Boolean(status.nativeAgent), lastMessage: message ? clean(message, 160) : null,
      lastFailed: /15 分钟后重试|无法读取/.test(message),
      // An unreadable config stops the toolkit's own schedule until the settings are saved again. A separate launchd
      // checker (nativeAgent) keeps running and saving does not clear the message there, so it is not flagged.
      configUnreadable: !status.nativeAgent && /无法读取/.test(message)};
  }

  // Approximates taobao_stock.workflow.load_job/_public without importing Python.
  async function inspectJob(directory) {
    const has = async name => Boolean(await io.stat(nodePath.join(directory, name)));
    let job;
    try {
      job = await io.readJson(nodePath.join(directory, 'job.json'), 64 * KB);
      if (!isObject(job)) throw Error('invalid');
    } catch {
      return (await has('state.json')) || (await has('events.jsonl')) ? 'review' : 'skip';
    }
    if (job.source_validated !== true) return 'skip';
    const hasState = await has('state.json');
    if (!hasState && await has('events.jsonl')) return 'review';
    const file = nodePath.join(directory, hasState ? 'state.json' : 'preview-progress.json');
    const info = await io.stat(file);
    if (!info || !info.isFile()) return 'review';
    if (info.size > 4 * MB) return 'unchecked';
    let run = parseCache.get(cacheKey(file, info));
    if (!run) {
      let read;
      try { read = await io.readTextInfo(file, 4 * MB); } catch { return 'review'; }
      try {
        const parsed = JSON.parse(read.text);
        run = isObject(parsed) ? {jobId: parsed.job_id, status: parsed.status} : {invalid: true};
      } catch { run = {invalid: true}; }
      remember(cacheKey(file, read.info), run);
    }
    if (run.invalid || run.jobId !== job.job_id) return 'review';
    if (FINAL_JOB_STATUSES.has(run.status)) return 'final';
    return {latest: {file: clean(baseName(job.source_filename), 60) || null,
      status: typeof run.status === 'string' ? run.status.slice(0, 40) : null, createdAt: isoText(job.created_at)}};
  }

  async function stockJobs(folder) {
    const names = (await io.list(folder, true)).filter(entry => entry.isDirectory() && JOB_NAME.test(entry.name))
      .map(entry => entry.name).sort().reverse().slice(0, 10);
    const jobs = {checked: 0, resumable: 0, needsReview: 0, unchecked: 0, latest: null};
    for (const name of names) {
      jobs.checked++;
      const verdict = await inspectJob(nodePath.join(folder, name));
      if (verdict === 'review') jobs.needsReview++;
      else if (verdict === 'unchecked') jobs.unchecked++;
      else if (isObject(verdict)) {
        jobs.resumable++;
        if (!jobs.latest) jobs.latest = verdict.latest;
      }
    }
    return jobs;
  }

  async function stockProbe(ctx) {
    const root = ctx.at('taobao-stock');
    const [profile, shop, jobs] = await Promise.all([
      io.stat(nodePath.join(root, '.browser-profile', 'er-dian')), io.stat(nodePath.join(root, '.runtime', 'shop.json')),
      stockJobs(nodePath.join(root, 'output', 'jobs'))]);
    return {login: {evidence: Boolean(profile), at: mtimeOf(profile)}, bound: Boolean(shop), jobs};
  }

  async function sycmTask(root) {
    const taskFile = nodePath.join(root, 'last-task.json');
    const taskInfo = await io.stat(taskFile);
    if (!taskInfo) return null;
    let task;
    try { task = await io.readJson(taskFile, 64 * KB); } catch { return {error: '上轮记录无效'}; }
    const runs = nodePath.join(root, 'runs') + nodePath.sep;
    if (!isObject(task) || typeof task.directory !== 'string' || !Array.isArray(task.args) ||
        !nodePath.resolve(task.directory).startsWith(runs)) return {error: '上轮记录无效'};
    const progressFile = nodePath.join(nodePath.resolve(task.directory), 'output', 'sycm', 'progress.json');
    const info = await io.stat(progressFile);
    let progress = null;
    if (info) { try { progress = await io.readJson(progressFile, 256 * KB); } catch {} }
    if (!isObject(progress)) return {stage: null, incomplete: true, at: mtimeOf(taskInfo)};
    // name and error are deliberately not copied: they hold product names.
    const stage = typeof progress.stage === 'string' ? progress.stage.slice(0, 40) : null;
    const index = numberOrNull(progress.index), total = numberOrNull(progress.total);
    const fail = numberOrNull(progress.fail);
    return {stage, index, total, ok: numberOrNull(progress.ok), fail, skipped: numberOrNull(progress.skipped),
      incomplete: stage !== 'done' || (fail ?? 0) > 0 || (index !== null && total !== null && index < total), at: mtimeOf(info)};
  }

  async function sycmProbe(ctx) {
    const root = ctx.at('sycm'), auth = nodePath.join(root, 'auth');
    // sycm_browser.save_login writes login_meta.json and sycm_state.json only after a login is detected;
    // the Chrome profile in auth/ is created even when the login was abandoned, so it is not evidence.
    const [meta, state, lastTask] = await Promise.all([io.stat(nodePath.join(auth, 'login_meta.json')),
      io.stat(nodePath.join(auth, 'sycm_state.json')), sycmTask(root)]);
    const newest = [meta, state].filter(info => info && info.isFile()).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    return {login: {evidence: Boolean(newest), at: newest ? mtimeOf(newest) : null}, lastTask};
  }

  // Mirrors readState in modules/taobao-soutu/state.mjs.
  function countSoutu(state) {
    if (!isObject(state)) return null;
    const records = {published: 0, pending: 0};
    let pendingGroup = null;
    for (const entry of Object.values(state)) {
      if (!isObject(entry) || !SOUTU_STATUSES.has(entry.status)) return null;
      records[entry.status]++;
      if (entry.status === 'pending' && pendingGroup === null && typeof entry.group === 'string') pendingGroup = clean(entry.group, 60);
    }
    return {records, pendingGroup};
  }

  async function soutuProbe(ctx) {
    const root = ctx.at('taobao-soutu');
    const [profile, key, lock, state] = await Promise.all([
      io.stat(nodePath.join(root, 'chrome-profile')), io.stat(ctx.at('taobao', 'model-key.bin')),
      io.stat(nodePath.join(root, 'run.lock')), summarizeState(nodePath.join(root, 'publish-state.json'), countSoutu)]);
    const records = state.value ? {...state.value.records} : state.missing ? {published: 0, pending: 0} : null;
    // The business error mentions .runtime/run.lock; the real lock is <userData>/taobao-soutu/run.lock.
    const ownTask = ctx.running?.tool === 'taobao-soutu';
    return {login: {evidence: Boolean(profile), at: mtimeOf(profile)}, hasKey: Boolean(key), records,
      recordsError: Boolean(state.invalid), recordsUnchecked: Boolean(state.unchecked), pendingGroup: state.value?.pendingGroup ?? null,
      staleLock: lock && !ownTask ? {at: mtimeOf(lock)} : null};
  }

  const toolProbes = {
    report: async ctx => ({login: {evidence: await ctx.erpEvidence()}}),
    price: async () => ({login: {evidence: passiveCredentials ? null : await cookieEvidence(sessions.price)}}),
    monthly: async ctx => {
      const [evidence, preview] = await Promise.all([ctx.erpEvidence(), lastPreview(ctx)]);
      return {login: {evidence}, lastPreview: preview};
    },
    'return-rate': async ctx => ({imported: Boolean(await io.stat(ctx.at('return-rate', 'kuaimai-api.enc')))}),
    taobao: taobaoProbe,
    'taobao-reminders': remindersProbe,
    'taobao-stock': stockProbe,
    sycm: sycmProbe,
    'taobao-soutu': soutuProbe,
  };

  // ------------------------------------------------ snapshot-only probes
  function appInfo() {
    const versions = proc.versions || {};
    let osVersion = attempt(() => typeof proc.getSystemVersion === 'function' ? proc.getSystemVersion() : null);
    if (!osVersion) osVersion = attempt(() => os.release());
    return {version: attempt(() => app.getVersion()), packaged: Boolean(app.isPackaged), platform: proc.platform ?? null,
      arch: proc.arch ?? null, os: osVersion ?? null, electron: versions.electron ?? null, chrome: versions.chrome ?? null,
      node: versions.node ?? null, locale: attempt(() => app.getLocale()), timeZone: attempt(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
      uptimeSec: attempt(() => Math.round(proc.uptime()))};
  }

  async function diskFree(directory) {
    if (typeof fs.statfs !== 'function') return null;
    try {
      const info = await fs.statfs(directory);
      const gb = Number(info.bavail) * Number(info.bsize) / 1e9;
      return Number.isFinite(gb) ? Math.round(gb * 10) / 10 : null;
    } catch { return null; }
  }

  async function runtimeProbe(ctx) {
    const [python, browser, parts, disk] = await Promise.all([pythonInfo(true), browserInfo(true), components(), diskFree(ctx.root)]);
    return {python, browser, encryption: encryption(), components: parts, diskFreeGB: disk};
  }

  // Newest version first (0.4.10 after 0.4.9), so old single-digit patches never crowd out recent ones.
  async function updateDirectories(root) {
    return (await io.list(root, true)).filter(entry => entry.isDirectory()).map(entry => entry.name)
      .sort((a, b) => compareVersions(b.split('-')[0], a.split('-')[0]) || (a < b ? 1 : a > b ? -1 : 0)).slice(0, 20);
  }

  async function updateProbe(ctx) {
    const root = ctx.at('updates');
    const [pending, names] = await Promise.all([io.stat(nodePath.join(root, 'pending.json')), updateDirectories(root)]);
    const found = await Promise.all(names.map(async name => {
      const file = nodePath.join(root, name, 'healthy.failed');
      const info = await io.stat(file);
      if (!info || !info.isFile()) return null;
      let reason;
      try { reason = clean(String(await io.readText(file, 8 * KB)).trim(), 300); } catch { reason = '原因记录过长或无法读取'; }
      return {version: name.split('-')[0], reason, at: mtimeOf(info), order: info.mtimeMs};
    }));
    // A failure for this version or an older one was superseded by the update that is now running.
    const current = attempt(() => String(app.getVersion()));
    const relevant = entry => !current || !/^\d+(\.\d+)*$/.test(entry.version) || compareVersions(entry.version, current) > 0;
    const failures = found.filter(Boolean).filter(relevant).sort((a, b) => b.order - a.order).slice(0, 5)
      .map(({version, reason, at}) => ({version, reason, at}));
    return {pending: Boolean(pending), failures};
  }

  async function logsProbe(ctx) {
    let startup = null, install = null;
    try { startup = clean(await io.readTail(ctx.at('startup.log'), 4 * KB), 6000) || null; } catch {}
    const root = ctx.at('updates');
    const candidates = await Promise.all((await updateDirectories(root)).map(async name => {
      const file = nodePath.join(root, name, 'install.log');
      return {file, info: await io.stat(file)};
    }));
    let newest = null;
    for (const candidate of candidates) {
      if (candidate.info?.isFile() && (!newest || candidate.info.mtimeMs > newest.info.mtimeMs)) newest = candidate;
    }
    if (newest) { try { install = clean(await io.readTail(newest.file, 4 * KB), 6000) || null; } catch {} }
    return {startup, install, ...(install && newest ? {installTarget:nodePath.basename(nodePath.dirname(newest.file)).split('-')[0]} : {})};
  }

  async function factsProbe(ctx) {
    const [api, key] = await Promise.all([io.stat(ctx.at('return-rate', 'kuaimai-api.enc')), io.stat(ctx.at('taobao', 'model-key.bin'))]);
    return {apiAt: mtimeOf(api), keyAt: mtimeOf(key)};
  }

  function reminderNote(value) {
    const schedule = value.nativeAgent ? `独立巡检 ${value.at ?? '时间未知'}` : value.enabled ? `每天 ${value.at ?? '时间未知'}` : '定时未启用';
    if (value.configDeferred) return '凭据未读取 · '+schedule;
    return `Webhook ${value.hasWebhook ? '已配置' : '未配置'} · @小谭 ${value.hasRecipient ? '已配置' : '未配置'} · ${schedule}`;
  }

  function logins(tools, facts) {
    const ok = key => isObject(tools[key]) && !('error' in tools[key]) ? tools[key] : null;
    const evidence = value => value === true ? 'present' : value === false ? 'missing' : 'unknown';
    const presence = (value, flag) => value ? (flag ? 'present' : 'missing') : 'unknown';
    const report = ok('report'), price = ok('price'), returnRate = ok('return-rate'), taobao = ok('taobao');
    const reminder = ok('taobao-reminders'), stock = ok('taobao-stock'), sycm = ok('sycm'), soutu = ok('taobao-soutu');
    const keyOwner = taobao || soutu;
    const imported = returnRate ? returnRate.imported === true : null;
    return [
      {id: 'kuaimai-erp', label: '快麦 ERP', tools: ['report', 'monthly'], state: evidence(report?.login?.evidence ?? null), at: null},
      {id: 'kuaimai-scm', label: '快麦通', tools: ['price'], state: evidence(price?.login?.evidence ?? null), at: null},
      {id: 'kuaimai-api', label: '快麦 API 配置', tools: ['return-rate'], state: imported ? 'configured' : 'unknown',
        at: imported ? facts?.apiAt ?? null : null, ...(imported === false ? {note: '未导入；进入退货率报表时会检查本机库存监控台配置'} : {})},
      {id: 'taobao', label: '淘宝专用浏览器', tools: ['taobao'], state: presence(taobao, taobao?.login?.evidence), at: taobao?.login?.at ?? null},
      {id: 'deepseek', label: 'DeepSeek 密钥', tools: ['taobao', 'taobao-soutu'],
        state: keyOwner ? (keyOwner.hasKey ? 'configured' : 'missing') : 'unknown', at: keyOwner?.hasKey ? facts?.keyAt ?? null : null},
      {id: 'qianniu-reminders', label: '千牛扫码（提醒）', tools: ['taobao-reminders'], state: presence(reminder, reminder?.hasLogin),
        at: null, ...(reminder ? {note: reminderNote(reminder)} : {})},
      {id: 'taobao-stock', label: '二店专用浏览器', tools: ['taobao-stock'], state: presence(stock, stock?.login?.evidence),
        at: stock?.login?.at ?? null, ...(stock?.bound ? {note: '已绑定店铺'} : {})},
      {id: 'sycm', label: '生意参谋登录', tools: ['sycm'], state: presence(sycm, sycm?.login?.evidence), at: sycm?.login?.at ?? null},
      {id: 'qianniu-soutu', label: '千牛专用浏览器（搜推）', tools: ['taobao-soutu'], state: presence(soutu, soutu?.login?.evidence),
        at: soutu?.login?.at ?? null},
    ];
  }

  // ------------------------------------------------ orchestration
  async function settle(tasks) {
    const done = new Map(), failed = new Set();
    const all = Promise.all(Object.entries(tasks).map(([key, task]) =>
      Promise.resolve().then(task).then(value => { done.set(key, value); }, () => { failed.add(key); })));
    await waitUpTo(all, timeoutMs);
    // Copy at the deadline so late results cannot change what was returned.
    return {done: new Map(done), failed: new Set(failed)};
  }

  function scrub(value) {
    if (typeof value === 'string') return clean(value, Infinity);
    if (Array.isArray(value)) return value.map(scrub);
    if (isObject(value)) {
      const result = {};
      for (const [key, item] of Object.entries(value)) result[key] = scrub(item);
      return result;
    }
    return value;
  }

  function runningNow() {
    const value = attempt(() => getRunning());
    if (!isObject(value)) return null;
    return {action: String(value.action ?? ''), tool: String(value.tool ?? ''), since: numberOrNull(value.since)};
  }

  async function collect(full) {
    const root = app.getPath('userData');
    let erp = null;
    const ctx = {root, at: (...parts) => nodePath.join(root, ...parts), running: runningNow(),
      erpEvidence: () => passiveCredentials ? null : (erp ??= cookieEvidence(sessions.report))};
    // Read the update trace before slower browser and Keychain probes consume
    // the snapshot timeout. A partial machine report should still explain updates.
    const events = full ? await waitUpTo(io.readTail(ctx.at('updates','update-events.log'), 4 * KB)
      .then(text => clean(text, 6000) || null, () => null), timeoutMs, null) : null;
    const tasks = {env: envProbe};
    for (const key of TOOL_KEYS) tasks['tool:' + key] = () => toolProbes[key](ctx);
    if (full) {
      Object.assign(tasks, {
        app: appInfo, runtime: () => runtimeProbe(ctx), update: () => updateProbe(ctx), facts: () => factsProbe(ctx),
        errors: async () => activity && typeof activity.errors === 'function' ? await activity.errors() : [],
        logs: () => logsProbe(ctx),
      });
    }
    const {done, failed} = await settle(tasks);
    let incomplete = false;
    const pick = (key, fallback) => {
      if (done.has(key)) return done.get(key);
      const reason = failed.has(key) ? '读取失败' : '超时';
      if (reason === '超时') incomplete = true;
      return fallback(reason);
    };
    const tools = {};
    for (const key of TOOL_KEYS) tools[key] = pick('tool:' + key, error => ({error}));
    const result = {schema: 1, processStartedAt, generatedAt: new Date().toISOString(), incomplete: false, running: ctx.running,
      env: pick('env', error => ({encryption: null, python: null, browser: {name: null}, components: {ok: null, missing: []}, error})),
      tools};
    if (full) {
      const facts = pick('facts', () => ({}));
      Object.assign(result, {
        app: pick('app', error => ({error})),
        runtime: pick('runtime', error => ({python: {ok: null, version: null}, browser: {ok: null, name: null, version: null},
          encryption: null, components: [], diskFreeGB: null, error})),
        update: pick('update', error => ({pending: null, failures: [], error})),
        logins: logins(tools, facts),
        activity: attempt(() => activity && typeof activity.recent === 'function' ? activity.recent() : [], []),
        errors: pick('errors', () => []),
        logs: {...pick('logs', error => ({startup: null, install: null, error})), events},
        paths: {userData: root, logs: nodePath.join(root, 'logs'), updates: nodePath.join(root, 'updates')},
      });
    }
    result.incomplete = incomplete;
    return scrub(result);
  }

  let overviewJob = null, snapshotJob = null;
  return {
    overview() {
      if (!overviewJob) overviewJob = collect(false).finally(() => { overviewJob = null; });
      return overviewJob;
    },
    snapshot() {
      if (!snapshotJob) snapshotJob = collect(true).finally(() => { snapshotJob = null; });
      return snapshotJob;
    },
  };
}

module.exports = {toolOf, createRedactor, createActivity, createDiagnostics, registerReadOnly};
