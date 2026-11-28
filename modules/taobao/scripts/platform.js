const {productQuery,productSearchQueries,matchProducts}=require('./catalog');
const URL='https://qn.taobao.com/home.htm/guanghe-creator/creation-tool/batch-publish';
const CONTROL_TIMEOUT=5000;
function errorMessage(error){
 const message=error instanceof Error?error.message:String(error||'未知错误');
 if(error?.name==='TimeoutError')return '淘宝页面操作超时，请重试';
 return message.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').split(/\r?\n|Call log:/)[0].trim().slice(0,180)||'未知错误';
}
function withFailures(rows,failures){Object.defineProperty(rows,'failures',{value:failures,enumerable:false});return rows;}
function frame(page){const f=page.frames().find(f=>f.url().includes('/qianniu-batch-video'));if(!f)throw Error('未找到淘宝批量编辑页，请先登录并打开批量发布');return f;}
function videoRow(f,file){
 return f.locator('.batchItemWrap').filter({has:f.locator('.batchItemTitle').and(f.getByText(file,{exact:true}))});
}
async function selectVideo(f,file){
 const row=videoRow(f,file);
 await row.locator('.batchItemTitle').click({timeout:CONTROL_TIMEOUT});
 await row.and(f.locator('.batchItemWrap-active')).waitFor({state:'visible',timeout:CONTROL_TIMEOUT});
}
function aiOptimizationSwitch(f){
 return f.locator('[class*="publish-content__publish-button--hosting-section--"]')
  .filter({has:f.getByText('AI优化',{exact:true})}).getByRole('switch');
}
async function assertAiOptimizationOff(f){
 try{
  await aiOptimizationSwitch(f).and(f.locator('[aria-checked="false"]')).waitFor({state:'visible',timeout:CONTROL_TIMEOUT});
 }catch(cause){throw Error('未确认该视频的 AI优化已关闭',{cause});}
}
async function disableAiOptimization(f){
 const control=aiOptimizationSwitch(f);
 try{
  await control.waitFor({state:'visible',timeout:CONTROL_TIMEOUT});
  const checked=await control.getAttribute('aria-checked',{timeout:CONTROL_TIMEOUT});
  // The platform switch supports Space, even when the sticky footer covers it.
  if(checked==='true')await control.press('Space',{timeout:CONTROL_TIMEOUT});
 }catch(cause){throw Error('无法关闭该视频的 AI优化',{cause});}
 await assertAiOptimizationOff(f);
}
async function closeHint(f){
 const buttons=f.getByRole('button',{name:'关闭',exact:true});
 for(let index=await buttons.count()-1;index>=0;index--){
  const button=buttons.nth(index);
  if(await button.isVisible())await button.dispatchEvent('click');
 }
}
function productDialog(f){
 return f.getByRole('dialog').filter({has:f.getByRole('searchbox',{name:'搜索'})});
}
async function cancelEditorDialog(dialog){
 if(await dialog.count()!==1)return;
 const cancel=dialog.getByRole('button',{name:'取消',exact:true});
 if(await cancel.count()!==1)return;
 await cancel.dispatchEvent('click',{}, {timeout:CONTROL_TIMEOUT});
 await dialog.waitFor({state:'hidden',timeout:CONTROL_TIMEOUT});
}
async function removeVideoFromBatch(f,file){
 try{
  const row=videoRow(f,file);
  const count=await row.count();
  if(count===0)return true;
  if(count!==1)return false;
  const icon=row.locator('.batchItemTop svg').filter({has:f.locator('use[*|href="#icondelete"]')});
  if(!await icon.isVisible())return false;
  await icon.dispatchEvent('click',{}, {timeout:CONTROL_TIMEOUT});
  const confirm=f.getByRole('dialog').filter({has:f.getByText('是否确认删除视频'+file,{exact:true})})
   .getByRole('button',{name:'确认',exact:true});
  await confirm.waitFor({state:'visible',timeout:CONTROL_TIMEOUT});
  await confirm.dispatchEvent('click',{}, {timeout:CONTROL_TIMEOUT});
  await row.waitFor({state:'detached',timeout:CONTROL_TIMEOUT});
  return true;
 }catch{return false;}
}
function isProductSearchRequest(request,f,query){
 if(request.method()!=='POST'||!/mtop\.taobao\.media\.guang\.item\.listitems/i.test(request.url()))return false;
 try{
  if(request.frame()!==f)return false;
  const payload=request.postDataJSON();
  const data=typeof payload?.data==='string'?JSON.parse(payload.data):payload?.data||payload;
  return data?.keyword===query&&!data.cursor;
 }catch{return false;}
}
async function searchProductResults(f,query,submit){
 const page=f.page(),requests=new WeakSet();
 const capture=request=>{if(isProductSearchRequest(request,f,query))requests.add(request);};
 // Opening the dialog also loads recommendations through this endpoint.
 page.on('request',capture);
 try{
  const [response]=await Promise.all([
   page.waitForResponse(r=>requests.has(r.request()),{timeout:15000}),
   submit(),
  ]);
  if(!response.ok())throw Error('商品搜索请求失败');
  const body=await response.json();
  const items=body?.data?.data;
  if(!body?.ret?.some(code=>/^SUCCESS(?:::|$)/.test(code))||!Array.isArray(items))throw Error('千牛返回商品搜索异常');
  if(!items.length&&(body.data.hasNext===true||body.data.hasNext==='true'))throw Error('千牛商品搜索结果尚未返回，请重试');
  return items.map(item=>{
   const id=String(item?.itemId||'');
   const title=typeof item?.title==='string'?item.title.trim():'';
   if(!/^\d+$/.test(id)||!title)throw Error('千牛商品搜索结果缺少商品信息');
   return {id,title};
  });
 }catch(cause){throw Error('未确认本次千牛商品搜索结果，请重试',{cause});}
 finally{page.off('request',capture);}
}
async function searchProduct(f,item){
 await closeHint(f);
 await selectVideo(f,item.file);
 const trigger=f.locator('[class*="publish-content__item-v2--items-trigger--"]:not([class*="--list-item-disabled--"])');
 const dialog=productDialog(f);
 const search=dialog.getByRole('searchbox',{name:'搜索'});
 try{
  await trigger.waitFor({state:'visible',timeout:CONTROL_TIMEOUT});
  // The outer iframe and sticky batch footer can intercept pointer clicks.
  await trigger.dispatchEvent('click',{}, {timeout:CONTROL_TIMEOUT});
  await search.waitFor({state:'visible',timeout:CONTROL_TIMEOUT});
 }catch(cause){throw Error('未能打开淘宝的关联商品窗口',{cause});}
 const query=item.query||productQuery(item.file);
 await search.fill(query);
 return searchProductResults(f,query,()=>dialog.getByRole('button',{name:'搜索',exact:true}).click({timeout:CONTROL_TIMEOUT}));
}
async function collectProducts(page,items,progress=()=>{}){
 const f=frame(page);await closeHint(f);const out=[],failures=[];
 for(const [index,item] of items.entries()){
  progress(`匹配商品 ${index+1}/${items.length}：${item.file}`);
  try{
   const queries=productSearchQueries(item.file);
   const expected=productQuery(item.file);
   let selected,query;
   const attempts=[];
   for(query of queries){
    const candidates=await searchProduct(f,{...item,query});
    const matches=matchProducts(candidates,expected);
    attempts.push(`“${query}”返回 ${candidates.length} 个候选`);
    await cancelEditorDialog(productDialog(f));
    if(matches.length>6)throw Error('同名商品超过淘宝单视频 6 个上限；'+attempts.join('；'));
    if(matches.length){selected=matches;break;}
   }
   if(!selected)throw Error('商品匹配失败；'+attempts.join('；'));
   out.push({...item,query,product_id:selected[0].id,product_name:selected[0].title,products:selected});
  }catch(error){
   await cancelEditorDialog(productDialog(f)).catch(()=>{});
   const removed=await removeVideoFromBatch(f,item.file);
   failures.push({file:item.file,stage:'商品匹配',error:errorMessage(error),removed});
  }
 }
 return withFailures(out,failures);
}
async function fetchTopics(page){return frame(page).evaluate(async()=>{
 const call=async(tabId,cursor)=>{
  const r=await window.__MTOP.request({api:'mtop.taobao.media.guang.topic.topicSelector',v:'1.0',data:{params:JSON.stringify({ugcScene:'qn_multi_publish',publishVersion:window.publishVersion||'0',site:window.site||'guangguang',tabId,cursor})},timeout:20000});
  if(!r.ret?.[0]?.startsWith('SUCCESS'))throw Error('话题读取失败，请检查登录');return r.data;
 };
 const first=await call('1',''),all=new Map();
 // Recommended + fashion tabs; no fixed activity IDs or cached candidates.
 const tabs=first.tabs.filter(t=>t.tabId==='1'||/时尚|服饰/.test(t.tabName));
 for(const tab of tabs){let cursor='';const seen=new Set();let complete=false;
  for(let n=0;n<5;n++){
   const d=tab.tabId==='1'&&n===0?first:await call(tab.tabId,cursor);
   for(const t of d.topics||[])all.set(t.sceneId,{id:t.sceneId,title:t.title,desc:t.desc,categories:t.firstCategoryNames,activities:t.activities?.map(a=>({title:a.title,begin:a.deliveryBegin,end:a.deliveryEnd,detail:a.detail}))});
   if(d.hasNext!==true&&d.hasNext!=='true'){complete=true;break;}
   if(!d.cursor||seen.has(d.cursor))throw Error('话题分页未完成');seen.add(d.cursor);cursor=d.cursor;
  }
  // This is a current candidate sample (up to five pages per tab), not a full topic export.
 }
 return [...all.values()];
 });}
async function inspectMedia(context,rows){
 const media=await context.newPage(),out=[],failures=[];
 try{for(const row of rows){
  try{
   await media.goto(require('node:url').pathToFileURL(row.path).href,{waitUntil:'domcontentloaded'});
   await media.waitForFunction(()=>Number.isFinite(document.querySelector('video')?.duration),null,{timeout:15000});
   out.push({...row,duration:await media.locator('video').evaluate(v=>v.duration)});
  }catch(error){failures.push({file:row.file,stage:'读取视频时长',error:errorMessage(error),removed:true});}
 }}finally{await media.close();}
 return withFailures(out,failures);
}
async function upload(page,rows,progress=()=>{}){
 const f=frame(page);await closeHint(f);
 const text=await f.locator('#root').innerText();
 if(/批量发布\s*[（(][1-9]/.test(text))throw Error('页面已有视频，请清空旧批次后再开始，避免混批');
 const input=page.locator('input[type=file]');const inner=f.locator('input[type=file]');
 const target=await input.count()?input:inner;
 if(await target.count()!==1)throw Error('上传入口不唯一，请打开批量发布上传页');
 await target.setInputFiles(rows.map(r=>r.path));
 progress('正在上传 '+rows.length+' 条视频…');
 const results=await Promise.all(rows.map(async row=>{
  try{
   const status=videoRow(f,row.file).locator('.batchItemStatus').getByText(/^(已上传|上传失败)$/);
   await status.waitFor({state:'visible',timeout:600000});
   if(await status.innerText()==='上传失败')throw Error('淘宝显示该视频上传失败');
   return {row};
  }catch(error){return {row,error};}
 }));
 const failed=results.filter(x=>x.error),success=results.filter(x=>!x.error).map(x=>x.row),failures=[];
 for(const result of failed){
  const removed=await removeVideoFromBatch(f,result.row.file);
  failures.push({file:result.row.file,stage:'上传',error:errorMessage(result.error),removed});
 }
 return withFailures(success,failures);
}
module.exports={URL,frame,errorMessage,closeHint,selectVideo,productDialog,searchProduct,searchProductResults,collectProducts,fetchTopics,upload,inspectMedia,removeVideoFromBatch,cancelEditorDialog,disableAiOptimization,assertAiOptimizationOff};
