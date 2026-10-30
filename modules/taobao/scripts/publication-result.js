async function armPublicationResult(page){
 await page.evaluate(()=>{
  window.__toolkitPublication=null;
  if(window.__toolkitPublicationListener)window.removeEventListener('message',window.__toolkitPublicationListener);
  window.__toolkitPublicationListener=e=>{
   if(e.origin!=='https://huodong.taobao.com')return;
   const trusted=[...document.querySelectorAll('iframe')].some(f=>f.contentWindow===e.source&&f.src.includes('/qianniu-batch-video'));
   if(!trusted)return;
   let data=e.data;try{if(typeof data==='string')data=JSON.parse(data);}catch{return;}
   if(data?.type==='onBatchPublishSuccess')window.__toolkitPublication=data;
  };
  window.addEventListener('message',window.__toolkitPublicationListener);
 });
}
function verifyPublication(data,choices){
 if(data?.type!=='onBatchPublishSuccess')return false;
 const entries=data.data?.publishData;
 if(!entries||Object.keys(entries).length!==choices.length)return false;
 return choices.every(c=>Object.hasOwn(entries,c.file));
}
async function waitPublicationResult(page,choices){
 try{await page.waitForFunction(()=>window.__toolkitPublication!==null,null,{timeout:120000});}catch{return {status:'unknown',message:'发布结果未完整返回，请到淘宝作品管理核实；本批次已锁定，不能再次提交。'};}
 const data=await page.evaluate(()=>window.__toolkitPublication);
 return verifyPublication(data,choices)?{status:'published',message:'淘宝已回传整批发布成功。'}:{status:'unknown',message:'淘宝返回的批次与本机清单不一致，请人工核实；已禁止重复提交。'};
}
module.exports={armPublicationResult,verifyPublication,waitPublicationResult};
