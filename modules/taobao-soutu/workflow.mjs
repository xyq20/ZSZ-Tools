import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { COMPLETED_DIRECTORY, prepareImages, productKey, scanMaterials, selectProductId } from './materials.mjs';
import { saveState } from './state.mjs';

export const seconds = milliseconds => `${(milliseconds / 1000).toFixed(1)} 秒`;

export async function lockPublishSource(source) {
  const lockPath = join(source, '.soutu-publish.lock');
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('该目录已有搜推发布任务。若上次异常中断，先核对已提交的素材，再处理 .soutu-publish.lock。');
    throw error;
  }
  return async () => {
    await handle.close();
    await unlink(lockPath);
  };
}

export async function resolveJobs(material, jobs, verifyMapped = false) {
  const resolved = [];
  const byKeyword = Map.groupBy(jobs, ({ group }) => group.keyword);
  for (const [keyword, related] of byKeyword) {
    const needsSearch = verifyMapped || related.some(job => !job.itemId);
    const products = needsSearch
      ? await material.retry(() => material.productCandidates(keyword, { ocr: verifyMapped && material.config.ocr }))
      : [];
    let checkedOcr = verifyMapped;
    for (const { group, itemId } of related) {
      if (verifyMapped && itemId && !products.some(product => product.id === itemId)) {
        throw new Error(`「${group.key}」配置的 ${itemId} 未在商品搜索结果中找到`);
      }
      let resolvedId = itemId;
      if (!resolvedId) {
        try {
          resolvedId = selectProductId(group, products);
        } catch (error) {
          if (!group.color || checkedOcr || !material.config.ocr || !products.length) throw error;
          await material.addOcrText(products);
          checkedOcr = true;
          await material.checkAccess();
          resolvedId = selectProductId(group, products);
        }
      }
      const ocr = Boolean(products.find(product => product.id === resolvedId)?.ocrText);
      resolved.push({ group, itemId: resolvedId, ocr, title: products.find(product => product.id === resolvedId)?.title ?? '' });
    }
  }
  return resolved;
}

export async function archivesFor(config, groups, resolved) {
  const result = new Map();
  const selected = Map.groupBy(resolved, ({ group }) => group.keyword);
  const sourceDirs = await readdir(config.source, { withFileTypes: true });
  for (const [keyword, jobs] of selected) {
    if (jobs.length !== groups.filter(group => group.keyword === keyword).length) continue;
    const names = sourceDirs.filter(entry => entry.isDirectory() && entry.name.normalize('NFC') === keyword);
    if (names.length !== 1) throw new Error(`无法确定归档所需的原目录「${keyword}」`);
    const original = join(config.source, names[0].name);
    const destination = join(config.source, COMPLETED_DIRECTORY, names[0].name);
    await assertArchiveDestination(destination);
    result.set(keyword, { jobs, original, destination });
  }
  return result;
}

async function assertArchiveDestination(path) {
  const existing = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) throw new Error(`归档目录已有同名文件：${path}`);
}

async function archiveIfComplete(config, state, archives, keyword, onProgress) {
  const entry = archives.get(keyword);
  if (!entry || entry.jobs.some(({ group, itemId }) => state[productKey(group, itemId)]?.status !== 'published')) return;
  const current = await scanMaterials(config.source, { folders: new Set([keyword]) });
  if (current.length !== entry.jobs.length || entry.jobs.some(({ group }) =>
        !current.some(found => found.key === group.key && found.fingerprint === group.fingerprint))) {
    throw new Error(`「${keyword}」的素材有变化，保留原目录待核对`);
  }
  const folder = join(config.source, COMPLETED_DIRECTORY);
  await mkdir(folder, { recursive: true });
  if (!(await lstat(folder)).isDirectory()) throw new Error(`归档位置不是实体目录：${folder}`);
  await assertArchiveDestination(entry.destination);
  await rename(entry.original, entry.destination);
  archives.delete(keyword);
  onProgress(`已移入「已上」 ${keyword}`);
  return keyword;
}

export async function runResolved({ material, config, runtime, resolved, archives = new Map(), state, publish = true, onProgress = console.log }) {
  const pending = Object.values(state).find(entry => entry.status === 'pending');
  if (publish && pending) throw new Error(`待确认记录：${pending.group} / ${pending.itemId}。请先在千牛核对。`);
  const unique = new Map();
  for (const { group, itemId } of resolved) {
    const key = productKey(group, itemId);
    if (publish && (state[key]?.status === 'published' || unique.has(key))) {
      onProgress(`跳过重复组 ${group.key} / ${itemId}`);
    } else {
      unique.set(key, { group, itemId });
    }
  }
  const previousVacancies = new Map();
  const remaining = new Map();
  for (const { itemId } of unique.values()) remaining.set(itemId, (remaining.get(itemId) ?? 0) + 1);
  let completed = 0;
  let lastSubmit = 0;
  const archived = [];
  const archive = async () => {
    for (const keyword of archives.keys()) {
      const name = await archiveIfComplete(config, state, archives, keyword, onProgress);
      if (name) archived.push(name);
    }
  };
  await archive();
  for (const [key, { group, itemId }] of unique) {
    const remainingDelay = lastSubmit + config.jobDelayMs - Date.now();
    if (remainingDelay > 0) await delay(remainingDelay);
    const prepareStart = performance.now();
    onProgress(`正在准备 ${group.key} / ${itemId}，共 ${group.images.length} 张图`);
    const images = await prepareImages(group);
    const imageTime = performance.now() - prepareStart;
    const prepared = await material.prepare(itemId, images, {
      vacanciesBelow: previousVacancies.get(itemId),
      neededSlots: remaining.get(itemId),
    });
    const timing = prepared.timings;
    onProgress(`图片处理 ${seconds(imageTime)}，定位 ${seconds(timing.locate)}，上传 ${seconds(timing.upload)}，AI 文案 ${seconds(timing.copy)}。标题 ${prepared.copy.title}`);
    if (!publish) {
      onProgress('图文预览已就绪。关闭独立浏览器可退出。');
      return { completed, archived, preview: true };
    }
    const entry = { group: group.key, itemId, title: prepared.copy.title, status: 'pending', time: new Date().toISOString(),
      ...(prepared.listing?.cover && { expectedCover: prepared.listing.cover }) };
    let hasPending = false;
    const submitStart = Date.now();
    try {
      const materialId = await material.submit(prepared, async () => {
        state[key] = entry;
        await saveState(runtime, state);
        hasPending = true;
        lastSubmit = Date.now();
      });
      state[key] = { ...entry, status: 'published', time: new Date().toISOString(),
        ...(materialId && { id: materialId }) };
      onProgress(`提交与回查 ${seconds(Date.now() - submitStart)}${materialId ? '，素材 ID ' + materialId : ''}`);
      await saveState(runtime, state);
    } catch (error) {
      if (!hasPending) throw error;
      throw new Error(`${group.key} / ${itemId} 的提交结果待核对。请检查素材列表后运行 resolve。`, { cause: error });
    }
    previousVacancies.set(itemId, prepared.vacancies);
    remaining.set(itemId, remaining.get(itemId) - 1);
    completed++;
    onProgress(`千牛已确认发布 ${group.key} / ${itemId}`);
    await archive();
  }
  onProgress(`本批千牛已确认 ${completed} 组`);
  return { completed, archived };
}
