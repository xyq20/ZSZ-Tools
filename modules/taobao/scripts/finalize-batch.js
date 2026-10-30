const { validateChoices } = require('./validate-choices');
/** Verify the entire visible batch. Publishing is opt-in and never retried here. */
async function finalizeBatch(page, choices, { publish = false } = {}) {
 validateChoices(choices);
  if (!choices.length || new Set(choices.map(x => x.file)).size !== choices.length)
    throw new Error('批次为空或包含重复视频');
  const f = page.frames().find(x => x.url().includes('qianniu-batch-video'));
  if (!f) throw new Error('未找到批量编辑页面');
  const text = await f.locator('#root').innerText();
  const count = Number(text.match(/批量发布\s*[（(](\d+)\/100/)?.[1]);
  if (count !== choices.length) throw new Error('页面视频数量与待发布清单不一致');
  if (await f.getByText('已上传', { exact: true }).count() !== count)
    throw new Error('仍有视频未完成上传');
  const verified = [];
  for (const item of choices) {
    await f.getByText(item.file, { exact: true }).click();
    const title = f.getByPlaceholder('加个标题让内容更吸引人');
    // Wait for the selected video's saved fields, rather than reading stale state.
    await f.waitForFunction(expected =>
      document.querySelector('input[placeholder="加个标题让内容更吸引人"]')?.value === expected,
      item.caption, { timeout: 5000 });
    const caption = await title.inputValue();
    const tags = (await f.locator('.rich-text-content').innerText()).replace(/\uFEFF/g, '');
    const chipCount = await f.locator('.rich-text-content [data-cangjie-void=true]').count();
    const body = await f.locator('#root').innerText();
    const productName = item.product_name || item.file.replace(/\s*\d+\.mp4$/i, '');
    if (!caption || [...caption].length > 30 || chipCount !== 4 ||
        tags !== '好物讲解精选好物商品展示时尚穿搭' ||
        !await f.getByRole('radio', { name: '内容无需标注', exact: true }).isChecked() ||
        !body.includes(item.topic_title) || !body.includes('1/6') ||
        !body.includes(productName))
      throw new Error('视频填写核验失败：' + item.file);
    verified.push(item.file);
  }
  const button = f.getByRole('button', { name: '批量发布', exact: true });
  if (await button.count() !== 1 || !await button.isEnabled())
    throw new Error('批量发布按钮不可用');
  if (!publish) return { status: 'ready_for_publish', clicked: false, verified };
  await button.click();
  // A click is not proof of publication. The caller must inspect the platform result.
  return { status: 'publish_clicked_requires_result_verification', clicked: true, verified };
}
module.exports = { finalizeBatch };
