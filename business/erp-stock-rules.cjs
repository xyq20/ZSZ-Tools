const fs = require('node:fs/promises');
const {readFileSync, mkdirSync, writeFileSync, renameSync} = require('node:fs');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {runtimePaths, runPython} = require('./monthly.cjs');
const {createErpStockSchedule, parseInterval} = require('./erp-stock-schedule.cjs');

const ERP_ORIGIN = 'https://erpa.superboss.cc';
const CAPACITY_RETRY_SECONDS = 180;

function ruleKey(rule) {
  return JSON.stringify([rule.name, String(rule.priority), rule.created_at]);
}

function restoreSelection(file, rules) {
  let saved;
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return rules;
  }
  if (!Array.isArray(saved) || !saved.length) return rules;
  const preferred = new Set(saved);
  const counts = new Map();
  for (const rule of rules) {
    const key = ruleKey(rule);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return rules.map(rule => {
    const key = ruleKey(rule);
    return rule.manual_status === '启用' && preferred.has(key) && counts.get(key) === 1
      ? {...rule, selected: true}
      : rule;
  });
}

function selectedRules(rules, numbers) {
  if (!Array.isArray(numbers) || !numbers.length || new Set(numbers).size !== numbers.length ||
      numbers.some(number => !Number.isSafeInteger(number) || number < 1 || number > rules.length)) {
    throw Error('请选择有效的库存规则。');
  }
  const selected = numbers.map(number => rules[number - 1]);
  if (selected.some(rule => rule.manual_status !== '启用')) {
    throw Error('所选规则中有未启用手动上传的规则。');
  }
  return selected;
}

function chromeCookies(cookies) {
  return cookies.map(cookie => {
    const {name, value, domain, path: cookiePath, httpOnly, secure, sameSite, expirationDate} = cookie;
    const policy = {strict: 'Strict', lax: 'Lax', no_restriction: 'None'}[sameSite];
    return {
      name, value, domain, path: cookiePath || '/', httpOnly, secure,
      ...(policy && {sameSite: policy}),
      ...(expirationDate && {expires: expirationDate}),
    };
  });
}

function createErpStockRulesTool({app, win, dialog, shell, getCookies, progress, notifySchedule = () => {},
  runner = runPython, waitForRetry = delay}) {
  const root = path.join(app.getPath('userData'), 'erp-stock-rules');
  const output = path.join(root, '全部上传规则.csv');
  const selection = path.join(root, 'last-selection.json');
  const home = app.getPath('home');
  const support = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    : path.join(home, 'Library', 'Application Support');
  const existing = path.join(support, 'ERP Excel Sync', 'ChromeProfile');
  const paths = {
    ...runtimePaths(app),
    bridge: path.join(app.isPackaged ? process.resourcesPath : __dirname, 'erp-stock-rules-python', 'bridge.py'),
  };
  let catalog = null;
  let retryWait = null;

  async function execute(job) {
    const hasExisting = await fs.stat(existing).then(entry => entry.isDirectory(), () => false);
    const profile = hasExisting ? existing : path.join(root, 'chrome');
    const cookies = hasExisting ? [] : chromeCookies(await getCookies(ERP_ORIGIN));
    return runner(paths, {...job, profile, cookies}, data => progress(data.message), {label: '库存规则'});
  }

  async function runUpload(job, stopping = () => false) {
    const accepted = [];
    let pending = job.numbers;
    while (true) {
      let result;
      try {
        result = await execute({...job, numbers:pending});
      } catch (error) {
        if (!accepted.length) throw error;
        return {complete:false, error:error.message,
          rows:[...accepted, ...pending.map(number => ({number,status:'结果待核实'}))]};
      }
      if (!result.retry) return {...result, rows:[...accepted, ...result.rows]};
      const index = pending.indexOf(result.retry.number);
      if (result.complete || result.retry.code !== '20030013' || result.retry.seconds !== CAPACITY_RETRY_SECONDS ||
          index < 0 || !Array.isArray(result.rows) || result.rows.length !== pending.length ||
          result.rows.some((row, position) => row.number !== pending[position] ||
            row.status !== (position < index ? '快麦已受理' : position === index ? '等待重试' : '未处理'))) {
        return {complete:false, error:'重试位置与快麦返回结果不符，请先核对。',
          rows:[...accepted, ...pending.map(number => ({number,status:'结果待核实'}))]};
      }
      accepted.push(...result.rows.slice(0,index));
      pending = pending.slice(index);
      if (!stopping()) {
        const controller = new AbortController();
        retryWait = controller;
        progress(`快麦已达到上传任务上限，已受理 ${accepted.length} 条。3 分钟后从规则 ${pending[0]} 继续。`, {retrying:true});
        try {
          await waitForRetry(CAPACITY_RETRY_SECONDS * 1000, undefined, {signal:controller.signal});
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally {
          retryWait = null;
          progress(controller.signal.aborted ? '已停止等待。' : '等待完成，正在重新核对规则。', {retrying:false});
        }
        if (!controller.signal.aborted && !stopping()) continue;
      }
      return {complete:false, cancelled:true, error:'已停止重试，已受理规则已保留。',
        rows:[...accepted, ...pending.map(number => ({number,status:'未处理'}))]};
    }
  }

  const schedule = createErpStockSchedule({file:path.join(root, 'schedule.json'), execute:runUpload, notify:notifySchedule});
  const describeRules = rules => rules.map(rule => `${rule.number}. ${rule.name}（优先级 ${rule.priority} · ${rule.created_at}）`).join('\n');

  return {
    async list() {
      catalog = null;
      catalog = await execute({action: 'list', output});
      return restoreSelection(selection, catalog.rules);
    },
    saveSelection(numbers) {
      if (!catalog) throw Error('请先读取库存规则。');
      const keys = Array.isArray(numbers) && numbers.length === 0
        ? []
        : selectedRules(catalog.rules, numbers).map(ruleKey);
      mkdirSync(root, {recursive:true,mode:0o700});
      const temporary = selection + '.tmp';
      writeFileSync(temporary, JSON.stringify(keys), {mode:0o600,flush:true});
      renameSync(temporary, selection);
    },
    async preview(numbers) {
      if (!catalog) throw Error('请先读取库存规则。');
      selectedRules(catalog.rules, numbers);
      return execute({action: 'preview', numbers, fingerprint: catalog.fingerprint, session: catalog.session});
    },
    async upload(numbers) {
      if (!catalog) throw Error('请先读取库存规则。');
      const selected = selectedRules(catalog.rules, numbers);
      const confirmation = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['取消', '确认上传'],
        defaultId: 0,
        cancelId: 0,
        message: `按所选的 ${selected.length} 条规则上传库存？`,
        detail: describeRules(selected),
      });
      if (confirmation.response !== 1) return null;
      const {fingerprint, session} = catalog;
      catalog = null;
      try {
        return await runUpload({action: 'upload', numbers, fingerprint, session});
      } catch (error) {
        throw Error(`${error.message}\n如有规则已点击确定，请先在快麦核对结果，再刷新清单。`);
      }
    },
    async reveal() {
      await fs.access(output);
      shell.showItemInFolder(output);
    },
    scheduleStatus: schedule.status,
    scheduleDue: schedule.isDue,
    runScheduled: schedule.runDue,
    cancelSchedule() {
      const state = schedule.cancel();
      if (state.state === 'stopping') retryWait?.abort();
      return state;
    },
    cancelRetry() {
      if (!retryWait) return false;
      if (schedule.status()?.state === 'running') schedule.cancel();
      retryWait.abort();
      return true;
    },
    updateScheduleInterval: schedule.updateInterval,
    async saveSchedule(numbers, value, unit) {
      if (!catalog) throw Error('请先读取库存规则。');
      const rules = selectedRules(catalog.rules, numbers);
      const {label} = parseInterval(value,unit);
      const replacing = schedule.status()?.state === 'pending';
      const result = await dialog.showMessageBox(win, {
        type:'question', buttons:['取消', '启用循环'], defaultId:0, cancelId:0,
        message:`每隔 ${label} 上传所选的 ${rules.length} 条规则？`,
        detail:[replacing ? '这会替换当前的循环上传。' : '',
          '首轮在一个间隔后启动。之后按固定间隔上传下列全部规则，上一轮仍在执行时跳过重叠轮次。请保持电脑唤醒、工具箱运行及快麦登录。', describeRules(rules)].filter(Boolean).join('\n\n'),
      });
      if (result.response !== 1) return null;
      return schedule.schedule(value, unit, rules, catalog.fingerprint, catalog.session);
    },
  };
}

module.exports = {createErpStockRulesTool, selectedRules};
