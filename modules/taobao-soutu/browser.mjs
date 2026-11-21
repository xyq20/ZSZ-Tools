import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, errors } from 'playwright-core';
import { recognizeImages } from './ocr.mjs';

export const MATERIAL_URL = 'https://myseller.taobao.com/home.htm/material-center/material-management?tab=recommend';
export const restrictMessage = '千牛出现安全验证、权限限制或访问频率提示，已暂停本次任务。';
const riskText = /访问过于频繁|请求过于频繁|操作过于频繁|请完成安全验证|请进行安全验证|滑[动块]验证|请拖动滑块|访问受限|访问被拒绝|无权访问|当前操作存在风险/;
const itemPattern = /商品\s*ID\s*[:：]?\s*(\d{8,20})(?!\d)/gi;
const readIds = text => [...new Set([...text.matchAll(itemPattern)].map(match => match[1]))];
const rowSelector = 'tr[class*="SingleList_materialCellColumn"]';
const materialCell = '.feeds-single-goods-content-item';
const materialIdPattern = /(?:^|\n)ID\s*[:：]?\s*(\d{8,20})(?!\d)/i;
const searchName = /商品名称\s*[/／]\s*ID/i;
const titleHint = /建议\s*10[-－–—~～至]\s*12个中文字符|添加标题/;
const descriptionHint = /建议\s*10[-－–—~～至]\s*1000个中文字符|内容描述/;
const qianniuSlot = '[class^="PublishButton_publish__"]';
const slotSelector = [
  qianniuSlot,
  '[aria-label*="添加素材"]', '[aria-label*="发布素材"]', '[title*="添加素材"]', '[title*="发布素材"]',
  '[data-testid*="empty-slot"]', '[class*="empty" i]', '[class*="placeholder" i]',
  '[class*="material-add" i]', '[class*="add-material" i]',
].join(', ');
const uploadFailure = /上传失败|图片上传异常/;
const invalidUpload = /图片比例不符|图片尺寸不符|图片格式不支持/;
const defaultSuccess = /^(?:素材发布成功|图文发布成功|发布成功|提交成功)$/;
const firstParty = host => /(?:^|\.)(?:taobao|tmall|alibaba)\.com$/i.test(host);

class TemporaryFailure extends Error {}

export async function launchBrowser(runtime, config) {
  const profile = join(runtime, 'chrome-profile');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const browser = await chromium.launchPersistentContext(profile, {
    ...(config.executablePath ? { executablePath: config.executablePath } : { channel: config.channel }),
    headless: false,
    viewport: null,
    handleSIGINT: false,
    handleSIGTERM: false,
    timeout: 30_000,
  });
  browser.setDefaultTimeout(config.actionTimeoutMs);
  browser.setDefaultNavigationTimeout(config.actionTimeoutMs);
  return browser;
}

function coverKey(src) {
  return src?.split(/[?#]/, 1)[0].match(/\/([^/]+?\.(?:jpe?g|png|webp))(?:[_.]|$)/i)?.[1] ?? '';
}

function visible(locator) {
  return locator.filter({ visible: true });
}

async function one(locator) {
  const matches = visible(locator);
  return await matches.count() === 1 ? matches : null;
}

export class MaterialPage {
  constructor(page, config) {
    this.page = page;
    this.config = config;
    this.restricted = false;
    page.on('response', response => {
      const type = response.request().resourceType();
      const { hostname } = new URL(response.url());
      if (firstParty(hostname) && (response.status() === 429 ||
        (response.status() === 403 && type === 'document'))) this.restricted = true;
    });
  }

  async checkAccess() {
    if (this.page.isClosed()) throw new Error('独立 Chrome 窗口已关闭');
    if (this.restricted) throw new Error(restrictMessage);
    const current = new URL(this.page.url());
    if (/(?:^|\.)login(?:myseller)?\./i.test(current.hostname) || /\/login(?:\/|\.htm|$)/i.test(current.pathname)) {
      throw new Error('千牛会话未登录或已过期，请运行 login 并在独立 Chrome 登录。');
    }
    for (const frame of this.page.frames()) {
      if (/x5sec|baxia|\/punish(?:[/?]|$)/i.test(frame.url()) ||
        await visible(frame.getByText(riskText)).count().catch(() => 0)) {
        throw new Error(restrictMessage);
      }
    }
  }

  async waitFor(operation, label, timeout = this.config.actionTimeoutMs) {
    const deadline = Date.now() + timeout;
    do {
      await this.checkAccess();
      const value = await operation();
      if (value) return value;
      await delay(250);
    } while (Date.now() < deadline);
    throw new TemporaryFailure(label);
  }

  async retry(operation, onStage) {
    const { maxAttempts, retryDelayMs } = this.config;
    for (let attempt = 1; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        await this.checkAccess();
        if (attempt >= maxAttempts || !(error instanceof TemporaryFailure ||
            error instanceof errors.TimeoutError || /net::ERR_(?:CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT)/.test(error.message))) {
          throw error;
        }
        this.searchSurface = undefined;
        const backoff = retryDelayMs * 2 ** (attempt - 1);
        const reason = error.message.split('\n')[0];
        console.warn(`第 ${attempt} 次准备失败，${backoff / 1000} 秒后重试。 ${reason}`);
        onStage?.(`${reason} · ${backoff / 1000} 秒后开始第 ${attempt + 1} 次尝试（共 ${maxAttempts} 次）`, 'retry');
        await delay(backoff);
        await this.checkAccess();
        onStage?.(`正在进行第 ${attempt + 1} 次尝试（共 ${maxAttempts} 次）`, 'active');
      }
    }
  }

  async enter({ refresh = false } = {}) {
    await this.checkAccess();
    if (!refresh && this.searchSurface && !this.searchSurface.frame.isDetached() &&
        await this.searchSurface.search.isVisible()) return this.searchSurface;
    this.searchSurface = undefined;
    const response = await this.page.goto(this.config.materialUrl, { waitUntil: 'domcontentloaded' });
    await this.checkAccess();
    if (response?.status() >= 500) throw new TemporaryFailure(`素材中心返回 HTTP ${response.status()}`);
    if (response?.status() >= 400) throw new Error(`素材中心返回 HTTP ${response.status()}`);
    if (this.config.shopText) {
      await this.waitFor(async () => {
        for (const frame of this.page.frames()) {
          if (await visible(frame.getByText(this.config.shopText, { exact: true })).count()) return true;
        }
        return false;
      }, `未找到配置的店铺标识「${this.config.shopText}」`);
    }

    const current = await this.waitFor(async () => {
      for (const frame of this.page.frames()) {
        const search = await one(frame.getByPlaceholder(searchName));
        if (search) return { frame, search };
        const tab = await one(frame.getByText('搜推素材', { exact: true }));
        if (tab) return { frame, tab };
      }
      return null;
    }, '找不到「搜推素材」入口或商品搜索框');
    if (current.search) {
      this.searchSurface = current;
      return current;
    }

    await current.tab.click();
    this.searchSurface = await this.waitFor(async () => {
      for (const frame of this.page.frames()) {
        const search = await one(frame.getByPlaceholder(searchName));
        if (search) return { frame, search };
      }
      return null;
    }, '搜推素材列表没有出现商品搜索框');
    return this.searchSurface;
  }

  async searchFor(frame, search, query) {
    if (await search.getAttribute('id') === 'itemIds') {
      await this.waitFor(async () => {
        const rows = await visible(frame.locator(rowSelector)).allInnerTexts();
        if (rows.some(text => readIds(text).length)) return true;
        return await visible(frame.locator('.next-table-empty').filter({ hasText: /没有数据|暂无数据/ })).count() > 0 &&
          !await visible(frame.locator('[role="progressbar"], .next-loading-indicator')).count();
      }, '商品列表尚未完成初始化');
    }
    await search.fill(query);
    await search.press('Enter');
    await this.checkAccess();
  }

  async closeIntro(frame) {
    const dialog = visible(frame.locator('.next-dialog').filter({ hasText: '种草素材升级为搜推素材啦' }));
    const close = await one(dialog.locator('.next-dialog-close'));
    if (close) {
      await this.checkAccess();
      await close.click();
      await dialog.waitFor({ state: 'hidden' });
    }
  }

  async selectProductMode(frame) {
    await this.closeIntro(frame);
    for (const name of ['单品素材', '按商品查看']) {
      const control = await one(frame.getByRole('button', { name, exact: true }).or(
        frame.getByRole('tab', { name, exact: true })));
      if (control && await control.isEnabled() &&
          await control.getAttribute('aria-selected') !== 'true' &&
          await control.getAttribute('aria-pressed') !== 'true' &&
          !/ToggleGroup_active__/.test(await control.getAttribute('class') ?? '')) {
        await this.checkAccess();
        await control.click();
      }
    }
  }

  async findProducts(keyword) {
    const { frame, search } = await this.enter();
    await this.selectProductMode(frame);
    await this.searchFor(frame, search, keyword);
    let previous = '';
    let stableSince = 0;
    let emptySince = 0;
    return this.waitFor(async () => {
      const currentRows = visible(frame.locator(rowSelector));
      const products = [];
      let resultCount = 0;
      if (await currentRows.count()) {
        const seen = new Set();
        for (const text of await currentRows.allInnerTexts()) {
          const [id] = readIds(text);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          resultCount++;
          const title = text.split(/商品\s*ID/i)[0].trim();
          if (title.normalize('NFC').includes(keyword)) products.push({ id, title: title.replace(/\s+/g, ' ') });
        }
      } else {
        const ids = readIds(await frame.locator('body').innerText());
        resultCount = ids.length;
        for (const id of ids) {
          const row = await this.productRow(frame, id, false);
          if (!row) continue;
          const title = (await row.innerText()).split(/商品\s*ID/i)[0].trim();
          if (title.normalize('NFC').includes(keyword)) products.push({ id, title: title.replace(/\s+/g, ' ') });
        }
      }
      const current = JSON.stringify(products);
      if (current !== previous) {
        previous = current;
        stableSince = Date.now();
      }
      const empty = !resultCount && await search.inputValue() === keyword &&
        await visible(frame.locator('.next-table-empty').filter({ hasText: /没有数据|暂无数据/ })).count() > 0 &&
        !await visible(frame.locator('[role="progressbar"], .next-loading-indicator')).count();
      emptySince = empty ? emptySince || Date.now() : 0;
      if (emptySince && Date.now() - emptySince >= 1000) return [];
      return products.length && products.length === resultCount && Date.now() - stableSince >= 400 ? products : null;
    }, `未找到标题包含「${keyword}」的商品，请在浏览器中核对关键词或直接填写商品 ID`);
  }

  async productCandidates(keyword, { ocr = this.config.ocr } = {}) {
    const products = await this.findProducts(keyword);
    if (!products.length) return products;
    for (const frame of this.page.frames()) {
      const list = frame.locator('[class*="SingleList_pagination"]');
      const next = await list.count() ? list.locator('button.next-next') :
        frame.getByRole('button', { name: /^下一页/ });
      for (const button of await visible(next).all()) {
        if (await button.isEnabled()) throw new Error(`「${keyword}」的搜索结果还有下一页，请核对后指定商品 ID。`);
      }
    }
    if (ocr) await this.addOcrText(products);
    return products;
  }

  async addOcrText(products) {
    const frames = this.page.frames();
    const captured = [];
    try {
      for (const product of products) {
        for (const frame of frames) {
          const row = await this.productRow(frame, product.id);
          if (!row) continue;
          const info = await one(row.locator('[class^="ProductCell_container__"]')) ??
            await one(row.locator('td').first()) ?? row;
          await info.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }), null, { timeout: 4000 });
          captured.push({ product, image: await info.screenshot({ scale: 'device', timeout: 4000 }) });
          break;
        }
      }
      const text = await recognizeImages(captured.map(entry => entry.image), { executable: this.config.ocrExecutable });
      captured.forEach(({ product }, index) => { product.ocrText = text[index] ?? ''; });
    } catch (error) {
      console.warn('OCR 暂不可用，继续核对页面文字和已配置的商品 ID。');
    }
  }

  async productRow(frame, itemId, requireSlot = true) {
    const configured = this.config.selectors.row;
    if (configured) {
      const candidates = frame.locator(configured).filter({
        hasText: new RegExp(`商品\\s*ID\\s*[:：]?\\s*${itemId}(?!\\d)`, 'i'),
      });
      const row = await one(candidates);
      return row && readIds(await row.innerText()).length === 1 ? row : null;
    }
    const anchor = await one(frame.getByText(itemId, { exact: true })) ??
      await one(frame.getByText(new RegExp(`(?:^|\\D)${itemId}(?!\\d)`)));
    if (!anchor) return null;
    let node = anchor;
    let matched = null;
    for (let depth = 0; depth < 12; depth++) {
      const rowInfo = await node.evaluate(element => ({
        text: element.innerText ?? '',
        structured: element.matches('tr, [role="row"], li, [class*="product-row"], [class*="item-row"]'),
        boundary: element.matches('body, html'),
      }));
      if (rowInfo.boundary) break;
      const ids = readIds(rowInfo.text);
      if (ids.length > 1) break;
      if (ids[0] === itemId && /类目|累计销量|当前发布/.test(rowInfo.text) && !/素材管理列表|按商品查看/.test(rowInfo.text)) {
        matched ??= node;
        if (!requireSlot || rowInfo.structured ||
          await visible(node.locator(this.config.selectors.emptySlot || slotSelector)).count()) return node;
      }
      node = node.locator('xpath=..');
    }
    return matched;
  }

  async emptySlots(row) {
    const isQianniuRow = await row.evaluate(el => el.matches('tr[class*="SingleList_materialCellColumn"]'));
    return visible(row.locator(this.config.selectors.emptySlot || (isQianniuRow ? qianniuSlot : slotSelector)));
  }

  async openDrawer(frame, slots) {
    await this.closeIntro(frame);
    slots = await slots.all();
    if (!slots.length) throw new Error('商品行内没有识别到空素材位，请检查剩余坑位或配置 selectors.emptySlot。');
    const menu = visible(frame.getByText('发图文', { exact: true }));
    if (await menu.count()) {
      const search = await one(frame.getByPlaceholder(searchName));
      if (search) await search.hover({ timeout: 1500 });
      try {
        await menu.first().waitFor({ state: 'hidden', timeout: 750 });
        if (await menu.count()) throw new TemporaryFailure('页面已有其他发图文菜单');
      } catch (error) {
        if (!(error instanceof errors.TimeoutError)) throw error;
        throw new TemporaryFailure('页面已有其他发图文菜单');
      }
    }
    for (const slot of slots.slice(0, 9)) {
      await this.checkAccess();
      await slot.hover();
      try {
        await menu.waitFor({ state: 'visible', timeout: 900 });
      } catch (error) {
        if (!(error instanceof errors.TimeoutError)) throw error;
        const likelySlot = this.config.selectors.emptySlot || await slot.evaluate(element => {
          const label = [element.getAttribute('aria-label'), element.title, element.className].join(' ');
          return /添加素材|发布素材|PublishButton_publish|empty.?slot|material.?add|add.?material/i.test(label);
        });
        if (!likelySlot) continue;
        await this.checkAccess();
        await slot.click();
        try {
          await menu.waitFor({ state: 'visible', timeout: 900 });
        } catch (clickError) {
          if (clickError instanceof errors.TimeoutError) continue;
          throw clickError;
        }
      }
      await this.checkAccess();
      await menu.click();
      return this.waitFor(async () => {
        for (const formFrame of this.page.frames()) {
          const title = await one(formFrame.getByPlaceholder(titleHint));
          const desc = await one(formFrame.locator('.rich-text-content')) ??
            await one(formFrame.getByPlaceholder(descriptionHint)) ?? await one(formFrame.locator('textarea'));
          if (!title || !desc) continue;
          const drawer = this.config.selectors.drawer
            ? await one(formFrame.locator(this.config.selectors.drawer))
            : title.locator('xpath=ancestor::*[.//textarea and (.//*[normalize-space()="确认"] or .//*[normalize-space()="取消"])][1]');
          if (drawer && await drawer.isVisible() &&
              await desc.isVisible()) return { drawer, title, desc };
        }
        return null;
      }, '「发布图文」面板未出现标题、内容描述和确认区域');
    }
    throw new Error('空素材位没有弹出「发图文」菜单，请核对页面结构。');
  }

  async uploadThroughPicker(trigger, images) {
    await trigger.click();
    const picker = await this.waitFor(async () => {
      for (const frame of this.page.frames()) {
        if (new URL(frame.url() || 'about:blank').pathname !== '/app/crs-qn/sucai-selector-ng/index') continue;
        const local = await one(frame.getByRole('button', { name: '本地上传', exact: true }));
        if (local) return { frame, local };
      }
      return null;
    }, '图片空间未打开本地上传入口');
    const [chooser] = await Promise.all([this.page.waitForEvent('filechooser'), picker.local.click()]);
    if (!chooser.isMultiple()) throw new Error('图片空间的本地上传控件不支持多选');
    await chooser.setFiles(images);

    const success = new RegExp(`^${images.length}\\s*个文件上传成功$`);
    await this.waitFor(async () => {
      if (await visible(picker.frame.getByText(/\d+\s*个文件上传失败/)).count()) {
        throw new Error('图片空间提示有文件上传失败，请查看上传结果。');
      }
      return await one(picker.frame.getByText(success));
    }, '图片空间没有确认整组文件上传成功', this.config.uploadTimeoutMs);
    await picker.frame.getByRole('button', { name: '完成', exact: true }).click();

    for (const { name } of images) {
      const card = await this.waitFor(() => one(picker.frame.locator('[class*="PicList_pic_background"]').filter({
        has: picker.frame.getByText(name, { exact: true }),
      })), `图片空间未显示本次上传的文件 ${name}`);
      await card.hover();
      await card.getByRole('checkbox').check();
    }

    const picked = new RegExp(`^确定\\s*[（(]\\s*${images.length}\\s*[）)]$`);
    await this.checkAccess();
    await picker.frame.getByRole('button', { name: picked }).click();
  }

  async upload(drawer, images) {
    if (await visible(drawer.getByText(/^[1-8]\s*[/／]\s*9$/)).count()) {
      throw new Error('发布面板已有图片，请确认素材位和表单初始状态。');
    }
    const uploadTrigger = this.config.selectors.uploadTrigger;
    const input = drawer.locator('input[type="file"]:not([webkitdirectory])');
    if (!uploadTrigger && await input.count() === 1) {
      if (await input.getAttribute('multiple') === null) {
        throw new Error('上传控件当前为单选，请核对图片上传控件或配置 selectors.uploadTrigger。');
      }
      await input.setInputFiles(images);
    } else if (!uploadTrigger && await one(drawer.locator('.next-picture-uploader'))) {
      await this.uploadThroughPicker(drawer.locator('.next-picture-uploader'), images);
    } else {
      const trigger = uploadTrigger ? drawer.locator(uploadTrigger) : drawer.getByText('点击上传图片', { exact: true });
      const [chooser] = await Promise.all([this.page.waitForEvent('filechooser'), visible(trigger).click()]);
      if (!chooser.isMultiple()) throw new Error('上传弹窗不支持一次添加整组图片');
      await chooser.setFiles(images);
    }

    const countText = new RegExp(`^${images.length}\\s*[/／]\\s*9$`);
    let readySince = 0;
    await this.waitFor(async () => {
      if (await visible(drawer.getByText(invalidUpload)).count()) {
        throw new Error('页面拒绝当前图片规格，请核对平台提示。');
      }
      if (await visible(drawer.getByText(uploadFailure)).count()) {
        throw new TemporaryFailure('页面提示图片上传失败');
      }
      const countVisible = await visible(drawer.getByText(countText)).count();
      const configured = this.config.selectors.uploadThumb;
      const uploadArea = drawer.locator('.content-picture-uploader-wrapper');
      const inlineImages = configured ? drawer.locator(configured) :
        await uploadArea.count() ? uploadArea.locator('img') : drawer.locator('img');
      const readyImages = await inlineImages.evaluateAll((nodes, explicit) => nodes.filter(node => {
        const image = node instanceof HTMLImageElement ? node : node.querySelector('img');
        if (!image?.complete || !image.naturalWidth || !/^https:\/\//i.test(image.currentSrc)) return false;
        if (explicit) return image.getClientRects().length > 0;
        const { width, height } = image.getBoundingClientRect();
        return width >= 65 && width <= 200 && height >= 65 && height <= 220 &&
          Math.abs(image.naturalWidth / image.naturalHeight - 0.75) < 0.04;
      }).length, Boolean(configured));
      const ready = (images.length === 9 || countVisible > 0) && readyImages === images.length;
      if (!ready) readySince = 0;
      else readySince ||= Date.now();
      return readySince && Date.now() - readySince >= 750;
    }, `没有确认 ${images.length} 张图片全部上传完成`, this.config.uploadTimeoutMs);
  }

  async readCopy({ title, desc }) {
    const description = await desc.evaluate(el => el instanceof HTMLTextAreaElement ? el.value : el.innerText);
    return {
      title: await title.inputValue(),
      description: description.replace(/^\uFEFF/, ''),
    };
  }

  async generateCopy(form) {
    const ai = await this.waitFor(() => one(form.drawer.getByText('AI生成文案', { exact: true })), '找不到「AI生成文案」入口');
    await ai.click();
    let applied = false;
    return this.waitFor(async () => {
      const copy = await this.readCopy(form);
      if (copy.title.trim() && copy.description.trim() && !copy.description.trim().startsWith('建议10')) return copy;
      if (!applied) {
        const fill = await one(form.drawer.getByRole('button', { name: '填充文案', exact: true }));
        if (fill && await fill.isEnabled()) {
          await this.checkAccess();
          await fill.click();
          applied = true;
        }
      }
      return null;
    }, '千牛 AI 未回填标题和描述，请查看文案生成面板。', this.config.uploadTimeoutMs);
  }

  async listedMaterials(row) {
    const results = [];
    for (const cell of await row.locator(materialCell).all()) {
      const text = await cell.innerText();
      const id = text.match(materialIdPattern)?.[1];
      if (id) results.push({ id, cell, text });
    }
    return results;
  }

  async findProductRow(itemId, options) {
    const { frame, search } = await this.enter(options);
    await this.selectProductMode(frame);
    if (!options?.refresh && await search.inputValue() === itemId) {
      const existing = await this.productRow(frame, itemId);
      if (existing) return { frame, row: existing };
    }
    await this.searchFor(frame, search, itemId);
    const row = await this.waitFor(() => this.productRow(frame, itemId), `结果中未找到精确商品 ID ${itemId}`);
    return { frame, row };
  }

  async confirmFromList({ listing, vacancies, imageCount }) {
    const verify = async frame => {
      const row = await this.productRow(frame, listing.itemId);
      if (!row) return null;
      const materials = await this.listedMaterials(row);
      const added = materials.filter(({ id }) => !listing.before.has(id));
      if (added.length > 1) throw new Error('同一商品同时出现多条新素材，须核对后继续。');
      const [entry] = added;
      if (!entry || ![...listing.before].every(id => materials.some(material => material.id === id)) ||
          await (await this.emptySlots(row)).count() !== vacancies - 1 ||
          entry.text.trimStart().split('\n', 1)[0].trim() !== String(imageCount)) return null;
      const cover = await one(entry.cell.locator('img[class^="MediaInfo_img__"]'));
      if (!cover) return null;
      await cover.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
      const shown = await cover.evaluate(img => img.currentSrc || img.src, null, { timeout: 1500 });
      return coverKey(shown) === listing.cover ? entry.id : null;
    };

    try {
      return await this.waitFor(() => verify(listing.frame), '当前列表尚未回显新增素材', 2500);
    } catch (error) {
      if (!(error instanceof TemporaryFailure || error instanceof errors.TimeoutError)) throw error;
    }
    const { frame } = await this.findProductRow(listing.itemId, { refresh: true });
    return this.waitFor(() => verify(frame), '列表未确认新素材的坑位、图片张数和封面，请先核对。');
  }

  async prepare(itemId, images, { vacanciesBelow, neededSlots = 1, onStage } = {}) {
    onStage?.('定位商品和空素材位');
    const locateAt = performance.now();
    const { form, vacancies, listing } = await this.retry(async () => {
      const { frame, row } = await this.findProductRow(itemId);
      const slots = await this.emptySlots(row);
      if (vacanciesBelow !== undefined) {
        await this.waitFor(async () => await slots.count() < vacanciesBelow, '前一组的占位尚未回显，暂停准备下一组');
      }
      const vacancies = await slots.count();
      if (vacancies < neededSlots) throw new Error(`商品 ${itemId} 有 ${vacancies} 个空框，当前需要 ${neededSlots} 个`);
      const listing = await row.locator(materialCell).count()
        ? { frame, itemId, before: new Set((await this.listedMaterials(row)).map(entry => entry.id)) }
        : null;
      return { form: await this.openDrawer(frame, slots), vacancies, listing };
    }, onStage);
    const uploadAt = performance.now();
    onStage?.('上传图片');
    await this.upload(form.drawer, images);
    const copyAt = performance.now();
    onStage?.('等待千牛 AI 生成文案');
    const copy = await this.generateCopy(form);
    const timings = { locate: uploadAt - locateAt, upload: copyAt - uploadAt, copy: performance.now() - copyAt };
    if (listing) {
      const thumb = form.drawer.locator(this.config.selectors.uploadThumb || '.content-picture-uploader-wrapper img').first();
      if (await thumb.count()) {
        listing.cover = coverKey(await thumb.evaluate(element => {
          const img = element instanceof HTMLImageElement ? element : element.querySelector('img');
          return img?.currentSrc || img?.src;
        }));
      }
    }
    await this.checkAccess();
    return { form, copy, vacancies, imageCount: images.length, listing, timings };
  }

  async submit(prepared, beforeClick, onSubmitted) {
    const { form, copy } = prepared;
    const { drawer } = form;
    const confirm = await one(drawer.getByRole('button', { name: '确认', exact: true })) ??
      await one(drawer.getByText('确认', { exact: true }));
    if (!confirm || !await confirm.isEnabled()) throw new Error('发布确认按钮不可用');
    const filled = await this.readCopy(form);
    if (filled.title !== copy.title || filled.description !== copy.description) throw new Error('图文文案在预览后发生变化');
    await this.checkAccess();
    const successVisible = async () => {
      for (const surface of this.page.frames()) {
        const notice = this.config.selectors.success
          ? surface.locator(this.config.selectors.success)
          : surface.getByText(defaultSuccess);
        if (await visible(notice).count().catch(() => 0)) return true;
      }
      return false;
    };
    if (prepared.listing && !prepared.listing.cover) throw new Error('无法读取封面地址，暂停提交以便发布后核对。');
    if (!prepared.listing && await successVisible()) throw new Error('页面已有发布成功提示，无法判断下一次提交结果');
    await confirm.click({ trial: true });
    await this.checkAccess();
    await beforeClick();
    await this.checkAccess();
    await confirm.click();
    onSubmitted?.();
    if (prepared.listing) {
      await this.waitFor(async () => !await drawer.isVisible().catch(() => false), '发布面板仍开启，请核对提交结果。');
      return this.confirmFromList(prepared);
    }
    await this.waitFor(successVisible, '未观察到发布成功提示，请先到素材列表核对。');
    return null;
  }
}
