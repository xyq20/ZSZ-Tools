const { searchProduct,removeVideoFromBatch,closeHint } = require('./platform');
const { validateChoices } = require('./validate-choices');
function errorMessage(error){return error instanceof Error?error.message:String(error||'未知错误');}
async function fillBatch(page, choices) {
 validateChoices(choices);
 const f=page.frames().find(f=>f.url().includes('qianniu-batch-video'));
 if(!f)throw Error('未找到批量编辑页面');
 await closeHint(f);
 const results=[],successChoices=[],failures=[];
 for(const item of choices){
  try{
   await searchProduct(f,item);
   const products=item.products||[{id:item.product_id,title:item.product_name}];
   for(const product of products){
    const link=f.locator('a[href*="item.taobao.com"][href*="id='+product.id+'"]').first();
    await link.waitFor();
    const row=link.locator('xpath=ancestor::*[.//input[@type="checkbox"]][1]');
    const checkbox=row.locator('input[type=checkbox]');
    if(await checkbox.count()!==1)throw Error('无法定位商品勾选框：'+product.id);
    if(await checkbox.getAttribute('aria-checked')!=='true')await checkbox.click();
    await row.locator('input[type=checkbox][aria-checked=true]').waitFor();
   }
   if(await f.locator('input[type=checkbox][aria-checked=true]').count()!==products.length)throw Error('勾选商品数量不一致');
   const confirmProducts=f.getByRole('button',{name:'确定',exact:true});
   if(!await confirmProducts.isEnabled())throw Error('商品确认按钮不可用');
   await confirmProducts.dispatchEvent('click');
   await confirmProducts.waitFor({state:'hidden',timeout:5000});
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
   results.push({file:item.file,caption:await f.getByPlaceholder('加个标题让内容更吸引人').inputValue(),tagCount:await f.locator('.rich-text-content [data-cangjie-void=true]').count(),decl:await f.getByRole('radio',{name:'内容无需标注',exact:true}).isChecked(),topic:await f.locator('#root').innerText().then(t=>t.includes(item.topic_title)),product:await f.locator('#root').innerText().then(t=>t.includes(products.length+'/6'))});
   successChoices.push(item);
  }catch(error){
   const dialog=f.getByRole('dialog');
   if(await dialog.count()){const cancel=dialog.getByRole('button',{name:'取消',exact:true});if(await cancel.count())await cancel.dispatchEvent('click').catch(()=>{});}
   const removed=await removeVideoFromBatch(f,item.file);
   failures.push({file:item.file,stage:'填写字段',error:errorMessage(error),removed});
  }
 }
 Object.defineProperty(results,'choices',{value:successChoices,enumerable:false});
 Object.defineProperty(results,'failures',{value:failures,enumerable:false});
 return results;
}
module.exports = { fillBatch };
