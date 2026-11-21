const fs = require('node:fs');
const path = require('node:path');
const { browserPath } = require('./taobao.cjs');

const defaults = require('../modules/taobao-soutu/defaults.json');

let bundle;
function loadCore() {
  bundle ??= Promise.all([
    import('../modules/taobao-soutu/browser.mjs'),
    import('../modules/taobao-soutu/materials.mjs'),
    import('../modules/taobao-soutu/state.mjs'),
    import('../modules/taobao-soutu/workflow.mjs'),
  ]).then(parts => Object.assign({}, ...parts));
  return bundle;
}

function createTaobaoSoutuTool({ app, win, dialog, shell, progress, coreLoader = loadCore, findBrowser = browserPath }) {
  const runtime = path.join(app.getPath('userData'), 'taobao-soutu');
  const suggested = process.platform === 'win32' ? '\\\\GONGXIANG\\美工文件\\搜推素材' : defaults.source;
  let source;
  let groups = [];
  let ready;
  let context;
  let material;

  const config = () => ({
    ...defaults,
    source,
    ...(app.isPackaged && process.platform === 'darwin'
      ? { ocrExecutable: path.join(process.resourcesPath, 'soutu-ocr') }
      : {}),
  });

  async function browser() {
    if (context && material && !material.page.isClosed()) return material;
    const executablePath = findBrowser();
    if (!executablePath) throw Error('请先安装 Google Chrome 或 Microsoft Edge。');
    const core = await coreLoader();
    const opened = await core.launchBrowser(runtime, { ...config(), executablePath });
    context = opened;
    opened.on('close', () => {
      if (context === opened) {
        context = null;
        material = null;
        ready = null;
      }
    });
    const page = opened.pages()[0] ?? await opened.newPage();
    material = new core.MaterialPage(page, config());
    return material;
  }

  async function cleanup() {
    const opened = context;
    context = null;
    material = null;
    ready = null;
    await opened?.close();
  }

  async function scan() {
    if (!source) return null;
    groups = await (await coreLoader()).scanMaterials(source);
    return {
      source,
      rows: groups.map(({ key, color, images, issue }) => ({ key, color, count: images.length, issue })),
    };
  }

  async function login() {
    const page = await browser();
    await page.page.bringToFront();
    if (page.page.url() === 'about:blank') {
      await page.page.goto(defaults.materialUrl, { waitUntil: 'domcontentloaded' });
    }
    try {
      await page.checkAccess();
      await page.enter();
      return { message: '千牛素材中心已就绪，后续操作会复用该会话。' };
    } catch (error) {
      if (!error.message.includes('会话未登录或已过期')) throw error;
      return { message: '请在专用浏览器中登录要发布的店铺，再回到工具箱核对商品。' };
    }
  }

  async function choose() {
    const result = await dialog.showOpenDialog(win, {
      title: '选择共享盘里的「搜推素材」文件夹',
      buttonLabel: '读取素材',
      properties: ['openDirectory'],
      ...(fs.existsSync(source ?? suggested) ? { defaultPath: source ?? suggested } : {}),
    });
    if (result.canceled || !result.filePaths[0]) return null;
    source = result.filePaths[0];
    ready = null;
    return scan();
  }

  async function withBatch(operation, total, work) {
    let count = 0;
    const report = (message, stage = 'active', confirmed = count, rows) => {
      count = confirmed;
      progress(message, { operation, count, total, stage, rows });
    };
    try {
      return await work(report);
    } catch (error) {
      report(error.message, error.code === 'SOUTU_PENDING' ? 'pending' : 'error');
      throw error;
    }
  }

  async function plan(selection) {
    ready = null;
    if (!source || !Array.isArray(selection) || !selection.length || selection.length > groups.length) {
      throw Error('请勾选要处理的素材组。');
    }
    return withBatch('check', selection.length, report => checkSelection(selection, report));
  }

  async function checkSelection(selection, report) {
    report('正在连接千牛并检查登录状态', 'active', 0,
      selection.map(row => ({ key: row?.key, status: '等待核对' })));
    const core = await coreLoader();
    const byKey = new Map(groups.map(group => [group.key, group]));
    const keys = new Set();
    const jobs = selection.map(row => {
      const group = byKey.get(row?.key);
      if (!group || keys.has(group.key) || group.issue) throw Error('素材列表已变化，请重新选择。');
      keys.add(group.key);
      return { group, itemId: row.itemId ? core.validateItemId(row.itemId) : undefined };
    });
    const page = await browser();
    await page.checkAccess();
    const state = await core.readState(runtime);
    const resolved = [];
    const missing = [];
    const matchedRow = ({ group, itemId, title, matchedColor }) => {
      const previous = state[core.productKey(group, itemId)];
      const status = matchedColor ? `核对通过（图片颜色：${matchedColor}）` : '核对通过';
      return { key: group.key, itemId, title, status: previous?.status === 'published' ? '已发布，跳过提交' : status };
    };
    const missingRow = (group, error) => ({ key: group.key, error: error.message, status: '待核对' });
    for (const [keyword, related] of Map.groupBy(jobs, job => job.group.keyword)) {
      const automatic = related.filter(job => !job.itemId);
      const manual = related.filter(job => job.itemId);
      if (automatic.length) {
        const label = automatic.length === 1 ? automatic[0].group.key : `${keyword}（${automatic.length} 组）`;
        report(`${label} · 正在等待千牛返回搜索结果`, 'active', resolved.length,
          automatic.map(({ group }) => ({ key: group.key, status: '核对中' })));
        let updates;
        try {
          const matches = await core.resolveJobs(page, automatic, false,
            (message, stage) => report(`${label} · ${message}`, stage));
          resolved.push(...matches);
          updates = matches.map(matchedRow);
        } catch (error) {
          await page.checkAccess();
          updates = automatic.map(({ group }) => missingRow(group, error));
          missing.push(...updates);
        }
        report(`${label} · 商品搜索结束`, 'active', resolved.length, updates);
      }
      for (const job of manual) {
        report(`${job.group.key} · 正在按商品 ID 核对`, 'active', resolved.length,
          [{ key: job.group.key, status: '核对中' }]);
        let update;
        try {
          const { row } = await page.retry(() => page.findProductRow(job.itemId),
            (message, stage) => report(`${job.group.key} · ${message}`, stage));
          const title = (await row.innerText()).split(/商品\s*ID/i)[0].replace(/\s+/g, ' ').trim();
          const match = { ...job, title };
          resolved.push(match);
          update = matchedRow(match);
        } catch (error) {
          await page.checkAccess();
          update = missingRow(job.group, error);
          missing.push(update);
        }
        report(`${job.group.key} · 商品 ID 核对结束`, 'active', resolved.length, [update]);
      }
    }
    const rows = [...resolved.map(matchedRow), ...missing];
    const pending = Object.values(state).find(entry => entry.status === 'pending');
    if (resolved.length && !pending) ready = { source, resolved, skipped: missing.length };
    report(pending
      ? `「${pending.group}」有待确认的发布记录，请先核对`
      : missing.length ? `${missing.length} 组待核对，请检查商品 ID` : '请检查匹配结果，再确认发布',
    pending ? 'pending' : missing.length ? 'partial' : 'done', resolved.length);
    return { rows, ready: Boolean(ready), pending: pending?.group || '', matched: resolved.length };
  }

  async function publish() {
    if (!ready || ready.source !== source) throw Error('先核对本批商品。');
    const selected = ready;
    const styles = new Set(selected.resolved.map(job => job.group.keyword));
    const confirmed = await dialog.showMessageBox(win, {
      type: 'question',
      message: `发布本批已核对的 ${selected.resolved.length} 组图文？`,
      detail: `涉及 ${styles.size} 款。整款全部回查成功后移入「已上」。${selected.skipped ? `本批有 ${selected.skipped} 组待核对，将留在原目录。` : ''}`,
      buttons: ['取消', '确认发布'],
      defaultId: 0,
      cancelId: 0,
    });
    if (confirmed.response !== 1) return null;
    ready = null;
    const core = await coreLoader();
    const keys = new Set(selected.resolved.map(({ group, itemId }) => core.productKey(group, itemId)));
    return withBatch('publish', keys.size, async report => {
      const result = await publishSelection(core, selected, styles, keys, report);
      report(`本批素材均已确认，${result.archived.length} 款移入「已上」`, 'done');
      return result;
    });
  }

  async function publishSelection(core, selected, styles, keys, report) {
    report('正在检查本批素材和共享目录');
    const unlock = await core.lockRuntime(runtime);
    try {
      const release = await core.lockPublishSource(source);
      try {
        const current = await core.scanMaterials(source, { folders: styles });
        for (const { group } of selected.resolved) {
          if (!current.some(entry => entry.key === group.key && entry.fingerprint === group.fingerprint)) {
            throw Error(`素材「${group.key}」已移动或发生变化，请重新选择目录并核对。`);
          }
        }
        const cfg = config();
        const state = await core.readState(runtime);
        const confirmedCount = () => [...keys].filter(key => state[key]?.status === 'published').length;
        report('正在核对发布记录和归档条件', 'active', confirmedCount());
        const archives = await core.archivesFor(cfg, current, selected.resolved);
        const result = await core.runResolved({
          material: await browser(), config: cfg, runtime, resolved: selected.resolved, archives, state,
          onProgress: progress,
          onBatch: (message, stage) => report(message, stage, confirmedCount()),
        });
        report('正在刷新待办素材', 'active', confirmedCount());
        const folder = await scan();
        return { ...result, folder };
      } finally {
        await release();
      }
    } finally {
      await unlock();
    }
  }

  async function history() {
    const state = await (await coreLoader()).readState(runtime);
    return Object.values(state).sort((a, b) => String(b.time).localeCompare(String(a.time)));
  }

  async function resolvePending() {
    const core = await coreLoader();
    const unlock = await core.lockRuntime(runtime);
    try {
      const state = await core.readState(runtime);
      const pending = Object.entries(state).find(([, entry]) => entry.status === 'pending');
      if (!pending) return { message: '当前没有待确认记录。' };
      const [key, entry] = pending;
      const page = await browser();
      await page.retry(() => page.findProductRow(entry.itemId, { refresh: true }));
      await page.page.bringToFront();
      const answer = await dialog.showMessageBox({
        type: 'question',
        message: `核对「${entry.group}」的提交结果`,
        detail: `商品 ID ${entry.itemId}\n标题 ${entry.title || ''}\n请根据刚打开的千牛素材列表选择结果。`,
        buttons: ['稍后核对', '确认已发布', '确认平台未收到'],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response === 0) return { message: '已保留待确认记录。' };
      if (answer.response === 1) state[key] = { ...entry, status: 'published', time: new Date().toISOString() };
      if (answer.response === 2) delete state[key];
      await core.saveState(runtime, state);
      ready = null;
      return { message: '记录已更新，可重新核对剩余的素材组。' };
    } finally {
      await unlock();
    }
  }

  async function openArchive() {
    if (!source) throw Error('请先选择搜推素材目录。');
    const target = path.join(source, '已上');
    if (!fs.existsSync(target)) throw Error('这个目录还没有「已上」文件夹。');
    const error = await shell.openPath(target);
    if (error) throw Error(error);
    return { message: '已打开「已上」。' };
  }

  return { login, choose, scan, plan, publish, history, resolvePending, openArchive, cleanup };
}

module.exports = { createTaobaoSoutuTool };
