const fs = require('node:fs/promises');
const path = require('node:path');
const {runtimePaths, runPython} = require('./monthly.cjs');
const {createErpStockSchedule, parseInterval} = require('./erp-stock-schedule.cjs');

const ERP_ORIGIN = 'https://erpa.superboss.cc';

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

function createErpStockRulesTool({app, win, dialog, shell, getCookies, progress, notifySchedule = () => {}, runner = runPython}) {
  const root = path.join(app.getPath('userData'), 'erp-stock-rules');
  const output = path.join(root, '全部上传规则.csv');
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

  async function execute(job) {
    const hasExisting = await fs.stat(existing).then(entry => entry.isDirectory(), () => false);
    const profile = hasExisting ? existing : path.join(root, 'chrome');
    const cookies = hasExisting ? [] : chromeCookies(await getCookies(ERP_ORIGIN));
    return runner(paths, {...job, profile, cookies}, data => progress(data.message), {label: '库存规则'});
  }

  const schedule = createErpStockSchedule({file:path.join(root, 'schedule.json'), execute, notify:notifySchedule});
  const describeRules = rules => rules.map(rule => `${rule.number}. ${rule.name}（优先级 ${rule.priority} · ${rule.created_at}）`).join('\n');

  return {
    async list() {
      catalog = null;
      catalog = await execute({action: 'list', output});
      return catalog.rules;
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
        return await execute({action: 'upload', numbers, fingerprint, session});
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
    cancelSchedule: schedule.cancel,
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
