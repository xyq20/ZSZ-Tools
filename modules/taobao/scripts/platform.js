const {productQuery}=require('./catalog');
const URL='https://qn.taobao.com/home.htm/guanghe-creator/creation-tool/batch-publish';
function frame(page){const f=page.frames().find(f=>f.url().includes('/qianniu-batch-video'));if(!f)throw Error('未找到淘宝批量编辑页，请先登录并打开批量发布');return f;}
async function closeHint(f){const b=f.getByRole('button',{name:'关闭',exact:true});if(await b.count()===1&&await b.isVisible())await b.click();}
async function searchProduct(f,item){
 await f.getByText(item.file,{exact:true}).click();
 await f.getByPlaceholder('加个标题让内容更吸引人').waitFor();
 await f.getByText('添加商品',{exact:true}).nth(1).click();
 await f.locator('a[href*="item.taobao.com"]').first().waitFor();
 const query=item.query||productQuery(item.file);
 const done=f.page().waitForResponse(r=>/mtop\.taobao\.media\.guang\.item\.listitems/i.test(r.url())&&r.request().method()==='POST',{timeout:15000}).catch(()=>null);
 await f.getByRole('searchbox',{name:'搜索'}).fill(query);
 await f.getByRole('button',{name:'搜索',exact:true}).click();
 const response=await done;if(response)await response.finished();
 if(!response)throw Error('商品搜索响应未确认，请重试；未选择商品');
 return query;
}
async function productCandidates(f){return f.locator('a[href*="item.taobao.com"]').evaluateAll(es=>es.map(e=>({id:new URL(e.href).searchParams.get('id'),title:e.textContent.trim()})));}
async function collectProducts(page,items,progress=()=>{}){
 const f=frame(page);await closeHint(f);const out=[];
 for(const [index,item] of items.entries()){
  progress(`匹配商品 ${index+1}/${items.length}：${item.file}`);
  const query=await searchProduct(f,item),candidates=await productCandidates(f);
  const matches=candidates.filter(c=>c.title.includes('【'+query+'】')||c.title===query);
  if(matches.length!==1)throw Error(`商品匹配${matches.length?'不唯一':'失败'}：${item.file}。请核对商品名`);
  out.push({...item,query,product_id:matches[0].id,product_name:matches[0].title});
  await f.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
 }
 return out;
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
 const media=await context.newPage(),out=[];
 try{for(const row of rows){
  await media.goto(require('node:url').pathToFileURL(row.path).href,{waitUntil:'domcontentloaded'});
  await media.waitForFunction(()=>Number.isFinite(document.querySelector('video')?.duration),null,{timeout:15000});
  out.push({...row,duration:await media.locator('video').evaluate(v=>v.duration)});
 }}finally{await media.close();}
 return out;
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
 for(const row of rows)await f.getByText(row.file,{exact:true}).waitFor({timeout:600000});
 await f.waitForFunction(n=>[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&e.textContent==='已上传').length===n,rows.length,{timeout:600000});
}
module.exports={URL,frame,closeHint,searchProduct,productCandidates,collectProducts,fetchTopics,upload,inspectMedia};
