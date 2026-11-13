const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');

// A trailing number is the clip sequence marker (for example `红海 2.mp4`),
// while numbers inside the product name are meaningful (`xx1xx.mp4`). Keep
// this rule in one place so matching and final verification cannot diverge.
function productNameFromFile(file){
 const stem=path.basename(String(file)).replace(/\.[^.]+$/,'').trim();
 const numberedRemark=stem.match(/^(.+?)\s+\d+\s+\S.*$/u);
 if(numberedRemark)return numberedRemark[1].trim();
 if(/\d+\.\d+$/.test(stem))return stem;
 return stem.replace(/(?:\s+|[_-])?\d+$/,'').trim() || stem;
}
function productQuery(file){return productNameFromFile(file);}
function productSearchQueries(file){
 const query=productQuery(file);
 const withoutCategory=query.replace(/(?:夹克|皮带)$/u,'');
 return [...new Set([query,withoutCategory].filter(Boolean))];
}
function matchProducts(candidates,query){
 const normalize=value=>String(value||'').normalize('NFKC').replace(/\s+/gu,'');
 const expected=normalize(query);
 if(!expected)return [];
 const unique=new Map();
 for(const candidate of candidates){
  if(!/^\d+$/.test(String(candidate.id||'')))continue;
  const title=normalize(candidate.title);
  const aliases=[...title.matchAll(/[【\[]([^【】\[\]]+)[】\]]/gu)].map(match=>match[1]);
  const exact=title===expected||aliases.includes(expected);
  const withCategory=aliases.some(alias=>{
   if(!expected.startsWith(alias))return false;
   const category=expected.slice(alias.length);
   return ['夹克','皮带'].includes(category)&&title.includes(category);
  });
  if(exact||withCategory)unique.set(String(candidate.id),candidate);
 }
 return [...unique.values()];
}
async function scanFolder(folder,history={}){
 const rows=[];let skipped=0;
 for(const e of (await fs.readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'))){
  if(!e.isFile()||! /\.mp4$/i.test(e.name))continue;
  if(/已传|已发布/.test(e.name)){skipped++;continue;}
  const file=path.join(folder,e.name),h=crypto.createHash('sha256');
  for await(const chunk of require('node:fs').createReadStream(file))h.update(chunk);
  const fingerprint=h.digest('hex'),previous=history[fingerprint];
  if(previous?.status==='published'){skipped++;continue;}
  rows.push({file:e.name,path:file,query:productQuery(e.name),fingerprint,status:previous?.status||'pending'});
 }
 if(!rows.length)throw Error('所选目录没有未标记为已传的 MP4 视频；请选择具体月份/周次目录');
 if(rows.length>100)throw Error('单批最多 100 条，请选择更小的目录');
 if(new Set(rows.map(x=>x.fingerprint)).size!==rows.length)throw Error('目录包含内容相同的视频，请先去重');
 return {folder,rows,skipped};
}
module.exports={scanFolder,productQuery,productNameFromFile,productSearchQueries,matchProducts};
