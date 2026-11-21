import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import sharp from 'sharp';

export const COMPLETED_DIRECTORY = '已上';

const mimeExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const digest = data => createHash('sha256').update(data).digest('hex');
const collator = new Intl.Collator('zh-CN', { numeric: true });

function isImage(entry) {
  return entry.isFile() && !entry.name.startsWith('.') && mimeExtensions.has(extname(entry.name).toLowerCase());
}

async function scanFolder(root, folder, groups) {
  const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) => collator.compare(a.name, b.name));
  const paths = entries.filter(isImage).map(entry => join(folder, entry.name));
  if (paths.length) {
    const key = relative(root, folder).split(sep).join('/').normalize('NFC');
    const unique = new Map();
    for (const path of paths) {
      const hash = digest(await readFile(path));
      if (!unique.has(hash)) unique.set(hash, { path, hash });
    }
    const names = key.split('/');
    groups.push({
      key,
      keyword: names[0],
      color: folderColor(key),
      images: [...unique.values()],
      duplicates: paths.length - unique.size,
      fingerprint: digest([...unique.keys()].sort().join(':')),
      issue: unique.size < 3 || unique.size > 9 ? '去重后须有 3–9 张图片' : '',
    });
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) await scanFolder(root, join(folder, entry.name), groups);
  }
}

export async function scanMaterials(root, { folders } = {}) {
  const groups = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== COMPLETED_DIRECTORY && !entry.name.startsWith('.') &&
        (!folders || folders.has(entry.name.normalize('NFC')))) {
      await scanFolder(root, join(root, entry.name), groups);
    }
  }
  return groups.sort((a, b) => collator.compare(a.key, b.key));
}

export async function prepareImages(group) {
  if (group.issue) throw new Error(`${group.key}：${group.issue}`);
  const images = [];
  const uploadName = `soutu-${randomUUID().slice(0, 12)}`;
  for (const [index, { path, hash }] of group.images.entries()) {
    const source = await readFile(path);
    if (digest(source) !== hash) throw new Error(`${basename(path)} 在扫描后被修改，请重新运行`);
    const transform = sharp(source).autoOrient()
      .resize(1440, 1920, { fit: 'contain', background: '#f5f5f5' })
      .flatten({ background: '#f5f5f5' });
    const jpeg = await transform.clone().jpeg({ quality: 93, mozjpeg: true }).toBuffer();
    const useJpeg = jpeg.length >= 200_000;
    const buffer = useJpeg ? jpeg : await transform.png().toBuffer();
    images.push({
      name: `${uploadName}-${String(index + 1).padStart(2, '0')}.${useJpeg ? 'jpg' : 'png'}`,
      mimeType: useJpeg ? 'image/jpeg' : 'image/png',
      buffer,
    });
  }
  return images;
}

export function productKey(group, itemId) {
  return `${itemId}:${group.fingerprint}`;
}

export function validateItemId(id) {
  if (typeof id !== 'string' || !/^\d{8,20}$/.test(id)) throw new Error('商品 ID 须填写为 8–20 位数字的字符串');
  return id;
}

const colorLabels = {
  红色: ['红色', '酒红', '枣红', '砖红', '红棕', '暗红', '红咖'],
  蓝色: ['蓝色', '藏蓝', '深蓝', '浅蓝', '宝蓝', '牛仔蓝', '雾蓝', '海军蓝'],
  黑色: ['黑色', '纯黑', '炭黑', '做旧黑'],
  白色: ['白色', '纯白', '米白', '奶白', '象牙白'],
  灰色: ['灰色', '烟灰', '炭灰', '浅灰', '深灰', '花灰'],
  绿色: ['绿色', '军绿', '墨绿', '橄榄绿', '草绿', '苔绿'],
  棕色: ['棕色', '咖啡色', '咖色', '深棕', '浅棕', '褐色'],
  卡其色: ['卡其色', '卡其'],
  黄色: ['黄色', '姜黄', '鹅黄', '浅黄', '芥末黄'],
  粉色: ['粉色', '粉红', '浅粉', '玫粉'],
  紫色: ['紫色', '葡萄紫', '香芋紫', '深紫', '浅紫'],
  橙色: ['橙色', '橘色', '橘红'],
};

function colorAliases(labels) {
  return [...new Set(labels.flatMap(label => label.endsWith('色') ? [label] : [label, label + '色']))];
}

const colors = Object.entries(colorLabels).map(([family, labels]) => [family, colorAliases(labels)]);
const colorByAlias = new Map(colors.flatMap(([family, labels]) => labels.map(label => [label, family])));
const titleColorPattern = new RegExp([...colorByAlias.keys()].sort((a, b) => b.length - a.length).join('|'), 'g');

export function folderColor(key) {
  for (const part of key.split('/').slice(1)) {
    const label = part.normalize('NFKC').trim().replace(/[-_\s]+\d+$/, '');
    const family = colors.find(([familyName, labels]) => label === familyName[0] || labels.includes(label));
    if (family) return family[0];
  }
  return '';
}

function normalizeSearch(text) {
  return text.normalize('NFKC').replace(/\s+/g, '');
}

function readColors(text, searchKey) {
  return (text.replaceAll(searchKey, '').match(titleColorPattern) ?? []).map(label => colorByAlias.get(label));
}

export function selectProductId({ keyword, color }, products) {
  if (color) {
    const searchKey = normalizeSearch(keyword);
    const byColor = products.map(product => ({ id: product.id, labels: readColors(normalizeSearch(product.title), searchKey) }));
    const direct = byColor.filter(product => product.labels.includes(color));
    if (direct.length === 1) return direct[0].id;
    if (byColor.length === 1 && !byColor[0].labels.length) return byColor[0].id;
  } else {
    if (products.length === 1) return products[0].id;
    const exact = products.filter(product =>
      normalizeSearch(product.title.match(/【([^】]+)】/)?.[1] ?? '') === normalizeSearch(keyword));
    if (exact.length === 1) return exact[0].id;
  }

  const available = products.map(product => `${product.id} ${product.title}`).join('；');
  throw new Error(`「${keyword}${color ? '/' + color : ''}」找到 ${products.length} 条商品，无法唯一核对${color ? '颜色' : ''}，请按分组指定商品 ID。${available}`);
}
