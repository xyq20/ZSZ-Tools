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

  async function plan(selection) {
    ready = null;
    if (!source || !Array.isArray(selection) || !selection.length || selection.length > groups.length) {
      throw Error('请勾选要处理的素材组。');
    }
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
    const rows = [];
    const resolved = [];
    const missing = [];
    for (const [keyword, related] of Map.groupBy(jobs, job => job.group.keyword)) {
      progress(`正在核对 ${keyword}…`);
      const automatic = related.filter(job => !job.itemId);
      const manual = related.filter(job => job.itemId);
      if (automatic.length) {
        try {
          resolved.push(...await core.resolveJobs(page, automatic));
        } catch (error) {
          await page.checkAccess();
          for (const { group } of automatic) missing.push({ key: group.key, error: error.message });
        }
      }
      for (const job of manual) {
        try {
          const { row } = await page.retry(() => page.findProductRow(job.itemId));
          const title = (await row.innerText()).split(/商品\s*ID/i)[0].replace(/\s+/g, ' ').trim();
          resolved.push({ ...job, title });
        } catch (error) {
          await page.checkAccess();
          missing.push({ key: job.group.key, error: error.message });
        }
      }
    }
    for (const { group, itemId, title } of resolved) {
      const previous = state[core.productKey(group, itemId)];
      rows.push({ key: group.key, itemId, title, status: previous?.status === 'published' ? '已发布，跳过提交' : '核对通过' });
    }
    rows.push(...missing.map(row => ({ ...row, status: '待核对' })));
    const pending = Object.values(state).find(entry => entry.status === 'pending');
    if (resolved.length && !pending) ready = { source, resolved, skipped: missing.length };
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
        const archives = await core.archivesFor(cfg, current, selected.resolved);
        const result = await core.runResolved({
          material: await browser(), config: cfg, runtime, resolved: selected.resolved, archives, state,
          onProgress: progress,
        });
        return { ...result, folder: await scan() };
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
