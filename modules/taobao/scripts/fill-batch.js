const { searchProduct } = require('./platform');
const { validateChoices } = require('./validate-choices');
async function fillBatch(page, choices) {
 validateChoices(choices);
 const f=page.frames().find(f=>f.url().includes('qianniu-batch-video'));
 if(!f)throw Error('未找到批量编辑页面');
 const close=f.getByRole('button',{name:'关闭',exact:true});if(await close.count())await close.click();
 const results=[];
 for(const item of choices){
  await searchProduct(f,item);
  await f.locator('a[href*="id='+item.product_id+'"]').waitFor();
  if(await f.locator('input[type=checkbox]').count()!==1)throw Error('商品候选非唯一');
  await f.locator('input[type=checkbox]').click();
  await f.locator('input[type=checkbox][aria-checked=true]').waitFor();
  await f.getByRole('button',{name:'确定',exact:true}).click();
  await f.getByPlaceholder('加个标题让内容更吸引人').fill(item.caption);
  await f.getByRole('radio',{name:'内容无需标注',exact:true}).click();
  await f.locator('.rich-text-content').click();await page.keyboard.press(process.platform==='darwin'?'Meta+A':'Control+A');await page.keyboard.press('Backspace');
  for(const tag of ['好物讲解','精选好物','商品展示','时尚穿搭']){
   await f.locator('.rich-text-content').click();await page.keyboard.press('End');
   await f.getByText('内容标签',{exact:true}).first().click();await page.keyboard.insertText(tag);await page.keyboard.press('Space');
   await f.getByPlaceholder('加个标题让内容更吸引人').click();
  }
  await f.getByText('点击添加话题',{exact:true}).click();
  await f.getByPlaceholder('输入关键词搜索').fill(item.topic_title);await f.getByRole('button',{name:'搜索',exact:true}).click();
  await f.getByText(item.topic_title,{exact:true}).click();await f.getByRole('button',{name:'确认提交',exact:true}).click();
  await f.getByPlaceholder('加个标题让内容更吸引人').click();
  results.push({file:item.file,caption:await f.getByPlaceholder('加个标题让内容更吸引人').inputValue(),tagCount:await f.locator('.rich-text-content [data-cangjie-void=true]').count(),decl:await f.getByRole('radio',{name:'内容无需标注',exact:true}).isChecked(),topic:await f.locator('#root').innerText().then(t=>t.includes(item.topic_title)),product:await f.locator('#root').innerText().then(t=>t.includes('1/6'))});
 }
 return results;
}
module.exports = { fillBatch };
