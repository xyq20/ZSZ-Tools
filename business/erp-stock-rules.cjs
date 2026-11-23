const fs = require('node:fs/promises');
const path = require('node:path');
const {runtimePaths, runPython} = require('./monthly.cjs');

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

function createErpStockRulesTool({app, win, dialog, shell, getCookies, progress, runner = runPython}) {
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
        detail: selected.map(rule => `${rule.number}. ${rule.name}（优先级 ${rule.priority} · ${rule.created_at}）`).join('\n'),
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
  };
}

module.exports = {createErpStockRulesTool, selectedRules};
