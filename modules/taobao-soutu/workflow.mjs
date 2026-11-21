import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { COMPLETED_DIRECTORY, prepareImages, productKey, scanMaterials, selectProductId } from './materials.mjs';
import { groupImageColor, matchProductImageColor, productImageColors } from './image-color.mjs';
import { saveState } from './state.mjs';

export const seconds = milliseconds => `${(milliseconds / 1000).toFixed(1)} 秒`;

function textMatch(group, products) {
  try {
    return { itemId: selectProductId(group, products) };
  } catch (error) {
    return { error };
  }
}

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

export async function resolveJobs(material, jobs, verifyMapped = false, onStage) {
  const resolved = [];
  const byKeyword = Map.groupBy(jobs, ({ group }) => group.keyword);
  for (const [keyword, related] of byKeyword) {
    const needsSearch = verifyMapped || related.some(job => !job.itemId);
    const products = needsSearch
      ? await material.retry(() => material.productCandidates(keyword, { ocr: verifyMapped && material.config.ocr }), onStage)
      : [];
    let checkedOcr = verifyMapped;
    let imageColors;
    for (const { group, itemId } of related) {
      if (verifyMapped && itemId && !products.some(product => product.id === itemId)) {
        throw new Error(`「${group.key}」配置的 ${itemId} 未在商品搜索结果中找到`);
      }
      let resolvedId = itemId;
      let matchedColor;
      if (!resolvedId) {
        let match = textMatch(group, products);
        if (match.error && group.color && products.length && !checkedOcr && material.config.ocr) {
          onStage?.('正在读取商品图片上的颜色文字');
          await material.addOcrText(products);
          checkedOcr = true;
          await material.checkAccess();
          match = textMatch(group, products);
        }
        resolvedId = match.itemId;
        if (!resolvedId && products.length > 1) {
          onStage?.(`${group.key} · 正在比对商品主图和素材颜色`);
          const color = await groupImageColor(group);
          if (!color) throw new Error(`分组图片颜色未能互相印证。 ${match.error.message}`, { cause: match.error });
          imageColors ??= await productImageColors(await material.productPortraits(products));
          resolvedId = matchProductImageColor({ keyword, color }, products, imageColors);
          if (!resolvedId) {
            const reason = imageColors.size < products.length ? '有候选主图无法读取' : '图片颜色无法唯一匹配';
            throw new Error(`${reason}。 ${match.error.message}`, { cause: match.error });
          }
          matchedColor = color;
        }
        if (!resolvedId) throw match.error;
      }
      const ocr = Boolean(products.find(product => product.id === resolvedId)?.ocrText);
      resolved.push({ group, itemId: resolvedId, ocr, title: products.find(product => product.id === resolvedId)?.title ?? '',
        ...(matchedColor && { matchedBy: 'image-color', matchedColor }) });
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

export async function runResolved({ material, config, runtime, resolved, archives = new Map(), state, publish = true, onProgress = console.log, onBatch }) {
  const pending = Object.values(state).find(entry => entry.status === 'pending');
  if (publish && pending) throw pendingError(`待确认记录：${pending.group} / ${pending.itemId}。请先在千牛核对。`);
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
  onBatch?.('检查已发布记录和归档条件');
  await archive();
  for (const [key, { group, itemId }] of unique) {
    const stage = (message, kind) => onBatch?.(`${group.key} · ${message}`, kind);
    const remainingDelay = lastSubmit + config.jobDelayMs - Date.now();
    if (remainingDelay > 0) {
      stage('等待下一组');
      await delay(remainingDelay);
    }
    const prepareStart = performance.now();
    stage(`处理 ${group.images.length} 张图片`);
    onProgress(`正在准备 ${group.key} / ${itemId}，共 ${group.images.length} 张图`);
    const images = await prepareImages(group);
    const imageTime = performance.now() - prepareStart;
    const prepared = await material.prepare(itemId, images, {
      vacanciesBelow: previousVacancies.get(itemId),
      neededSlots: remaining.get(itemId),
      onStage: stage,
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
      stage('正在向千牛提交图文');
      const materialId = await material.submit(prepared, async () => {
        state[key] = entry;
        await saveState(runtime, state);
        hasPending = true;
        lastSubmit = Date.now();
      }, () => stage('正在回查千牛发布结果'));
      state[key] = { ...entry, status: 'published', time: new Date().toISOString(),
        ...(materialId && { id: materialId }) };
      onProgress(`提交与回查 ${seconds(Date.now() - submitStart)}${materialId ? '，素材 ID ' + materialId : ''}`);
      await saveState(runtime, state);
    } catch (error) {
      if (!hasPending) throw error;
      throw pendingError(`${group.key} / ${itemId} 的提交结果待核对。请检查素材列表后运行 resolve。`, error);
    }
    previousVacancies.set(itemId, prepared.vacancies);
    remaining.set(itemId, remaining.get(itemId) - 1);
    completed++;
    onProgress(`千牛已确认发布 ${group.key} / ${itemId}`);
    stage('千牛已确认发布');
    await archive();
  }
  onProgress(`本批千牛已确认 ${completed} 组`);
  return { completed, archived };
}

function pendingError(message, cause) {
  const error = new Error(message, { cause });
  error.code = 'SOUTU_PENDING';
  return error;
}
