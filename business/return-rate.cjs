const fs = require('node:fs/promises');
const path = require('node:path');
const {runtimePaths, runPython} = require('./monthly.cjs');

const SHANGHAI_MONTH = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
});
const CONFIG_FIELDS = ['appKey', 'appSecret', 'session'];

function apiConfig(raw) {
  if (!raw || CONFIG_FIELDS.some(key => typeof raw[key] !== 'string' || !raw[key].trim())) {
    throw Error('快麦 API 配置需包含 appKey、appSecret 和 session');
  }
  return Object.fromEntries(CONFIG_FIELDS.map(key => [key, raw[key].trim()]));
}

function validateOptions(input, now = new Date()) {
  const {month, minimum, companyId, excluded, selectionGroup} = input || {};
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month.startsWith('0000')
      || month >= SHANGHAI_MONTH.format(now)) {
    throw Error('请选择已结束的付款月份');
  }
  if (!Number.isSafeInteger(minimum) || minimum < 1) throw Error('销量门槛请输入正整数');
  if (typeof companyId !== 'string' || !/^\d{1,20}$/.test(companyId.trim())) throw Error('请输入快麦 ERP 公司编号');
  if (typeof selectionGroup !== 'string' || !selectionGroup.trim() || selectionGroup.length > 100) {
    throw Error('请输入选款使用的店铺分组');
  }
  if (typeof excluded !== 'string' || excluded.length > 20000) throw Error('排除商家编码无效');
  return {
    month, minimum, companyId: companyId.trim(), selectionGroup: selectionGroup.trim(),
    excludedCodes: [...new Set(excluded.split(/[\r\n,，、]+/).map(code => code.trim()).filter(Boolean))],
  };
}

function createReturnRateTool({app, win, dialog, shell, safeStorage, progress, runner = runPython}) {
  const home = app.getPath('home');
  const root = path.join(app.getPath('userData'), 'return-rate');
  const secret = path.join(root, 'kuaimai-api.enc');
  const localProjects = path.join(home, 'Desktop', '电商自动化');
  const localConfig = path.join(localProjects, '6.库存监控台', '.local', 'official.json');
  const localERP = path.join(localProjects, '1.快麦excel导入脚本', 'config.json');
  const dedicatedChrome = path.join(root, 'chrome');
  const existingChrome = path.join(home, 'Library', 'Application Support', 'ERP Excel Sync', 'ChromeProfile');
  const paths = {
    ...runtimePaths(app),
    bridge: path.join(app.isPackaged ? process.resourcesPath : __dirname, 'return-rate-python', 'bridge.py'),
  };
  const fixedExcludedCodes = require(path.join(path.dirname(paths.bridge), "excluded-codes.json"));
  let resultFile;

  async function savedConfig() {
    let data;
    try { data = await fs.readFile(secret); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    try {
      return JSON.parse(safeStorage.decryptString(data));
    } catch {
      throw Error('本机快麦 API 配置无法解密，请重新导入');
    }
  }

  async function localCompanyId() {
    try {
      return String(JSON.parse(await fs.readFile(localERP, 'utf8')).company_id || '');
    } catch {
      return '';
    }
  }

  async function findConfig() {
    const saved = await savedConfig();
    if (saved) return {config: apiConfig(saved.config), source: '已导入本机配置', companyId: saved.companyId};
    try {
      const raw = JSON.parse(await fs.readFile(localConfig, 'utf8'));
      return {config: apiConfig(raw), source: '使用本机库存监控台配置', companyId: await localCompanyId()};
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw Error('本机快麦 API 配置无效，请导入有效配置');
    }
  }

  async function status() {
    try {
      const found = await findConfig();
      return {configured: Boolean(found), source: found?.source || '',
        companyId: found?.companyId || await localCompanyId(), fixedExcludedCodes};
    } catch (error) {
      return {configured:false, source:error.message, companyId:'', fixedExcludedCodes};
    }
  }

  async function importConfig() {
    if (!safeStorage.isEncryptionAvailable()) throw Error('系统加密不可用，无法保存快麦 API 配置');
    const choice = await dialog.showOpenDialog(win, {
      title: '导入快麦开放平台 API 配置',
      properties: ['openFile'],
      filters: [{name: 'JSON 配置', extensions: ['json']}],
    });
    if (choice.canceled) return null;
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(choice.filePaths[0], 'utf8'));
    } catch {
      throw Error('无法读取选中的 JSON 配置文件');
    }
    const config = apiConfig(raw);
    const companyId = String(raw.company_id || raw.companyId || await localCompanyId()).trim();
    await fs.mkdir(root, {recursive: true, mode: 0o700});
    const temporary = path.join(root, 'kuaimai-api.tmp');
    try {
      await fs.writeFile(temporary, safeStorage.encryptString(JSON.stringify({config, companyId})), {mode: 0o600});
      await fs.rename(temporary, secret);
    } finally {
      await fs.rm(temporary, {force: true});
    }
    return status();
  }

  async function chromeProfile() {
    try { await fs.access(dedicatedChrome); return dedicatedChrome; } catch {}
    if (process.platform === 'darwin') {
      try { await fs.access(existingChrome); return existingChrome; } catch {}
    }
    return dedicatedChrome;
  }

  async function start(options) {
    const request = validateOptions(options);
    const found = await findConfig();
    if (!found) throw Error('请先导入快麦开放平台 API 配置');
    const choice = await dialog.showSaveDialog(win, {
      title: '保存退货率报表', buttonLabel: '查询并保存',
      defaultPath: path.join(app.getPath('downloads'), `${request.month}退货率_付款时间.xlsx`),
      filters: [{name: 'Excel 工作簿', extensions: ['xlsx']}],
    });
    if (choice.canceled || !choice.filePath) return null;
    if (path.extname(choice.filePath).toLowerCase() !== '.xlsx') throw Error('请选择 .xlsx 保存路径');
    const job = {...request, output: choice.filePath, profile: await chromeProfile(), officialConfig: found.config};
    const result = await runner(paths, job, data => progress(data.message, data), {label: '退货率'});
    const output = await fs.realpath(choice.filePath);
    if (await fs.realpath(result.file) !== output) throw Error('退货率程序返回了异常的保存路径');
    resultFile = output;
    return {...result, file: output};
  }

  async function reveal() {
    if (!resultFile) throw Error('请先导出退货率报表');
    await fs.access(resultFile);
    shell.showItemInFolder(resultFile);
  }

  return {status, importConfig, start, reveal};
}

module.exports = {createReturnRateTool, validateOptions};
