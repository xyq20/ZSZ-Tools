const { validateChoices } = require('./validate-choices');
const { productNameFromFile } = require('./catalog');
const { removeVideoFromBatch } = require('./platform');
function errorMessage(error){return error instanceof Error?error.message:String(error||'未知错误');}
/** Verify the entire visible batch. Publishing is opt-in and never retried here. */
async function finalizeBatch(page, choices, { publish = false } = {}) {
 validateChoices(choices);
  if (!choices.length || new Set(choices.map(x => x.file)).size !== choices.length)
    throw new Error('批次为空或包含重复视频');
  const f = page.frames().find(x => x.url().includes('qianniu-batch-video'));
  if (!f) throw new Error('未找到批量编辑页面');
  const text = await f.locator('#root').innerText();
  const count = Number(text.match(/批量发布\s*[（(](\d+)\/100/)?.[1]);
  if (count < choices.length) throw new Error('页面视频数量少于待发布清单');
  if (await f.getByText('已上传', { exact: true }).count() !== count)
    throw new Error('仍有视频未完成上传');
  const verified = [],failed=[];
  for (const item of choices) {
    try {
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
      const productName = item.product_name || productNameFromFile(item.file);
      const products=item.products||[{id:item.product_id,title:productName}];
      // The editor renders thumbnails without titles when several products are linked.
      const savedProductIds=await f.locator('[class*="publish-content__item-v2--list-item"][data-id]').evaluateAll(elements=>elements.map(element=>element.getAttribute('data-id')));
      const problems=[];
      if(caption!==item.caption||[...caption].length>30)problems.push('描述不一致');
      if(chipCount!==4||tags!=='好物讲解精选好物商品展示时尚穿搭')problems.push('内容标签不完整');
      if(!await f.getByRole('radio',{name:'内容无需标注',exact:true}).isChecked())problems.push('声明未选中');
      if(!body.includes(item.topic_title))problems.push('话题未回读到');
      if(!body.replace(/\s/g,'').includes(products.length+'/6'))problems.push('商品数量未回读到 '+products.length+'/6');
      const expectedIds=products.map(product=>String(product.id)).sort();
      if(JSON.stringify([...savedProductIds].sort())!==JSON.stringify(expectedIds))problems.push('关联商品 ID 不一致，预期 '+expectedIds.join('、')+'，实际 '+savedProductIds.join('、'));
      if(problems.length)throw Error('视频填写核验失败：'+item.file+'；'+problems.join('；'));
      verified.push(item.file);
    } catch (error) {
      const removed=await removeVideoFromBatch(f,item.file);
      failed.push({file:item.file,stage:'发布前核验',error:errorMessage(error),removed});
    }
  }
  const verifiedChoices=choices.filter(item=>verified.includes(item.file));
  const remainingText=await f.locator('#root').innerText();
  const remainingCount=Number(remainingText.match(/批量发布\s*[（(](\d+)\/100/)?.[1]);
  if(failed.some(item=>!item.removed)||remainingCount!==verifiedChoices.length)
    return {status:'blocked',clicked:false,verified,choices:verifiedChoices,failed};
  if(!verifiedChoices.length)return {status:'no_success',clicked:false,verified,choices:[],failed};
  const button = f.getByRole('button', { name: '批量发布', exact: true });
  if (await button.count() !== 1 || !await button.isEnabled())
    throw new Error('批量发布按钮不可用');
  if (!publish) return { status: 'ready_for_publish', clicked: false, verified, choices:verifiedChoices, failed };
  await button.click();
  // A click is not proof of publication. The caller must inspect the platform result.
  return { status: 'publish_clicked_requires_result_verification', clicked: true, verified, choices:verifiedChoices, failed };
}
module.exports = { finalizeBatch };
