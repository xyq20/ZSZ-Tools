const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
function productQuery(file){return path.basename(file).replace(/\.[^.]+$/,'').replace(/\s*\d+$/,'').trim();}
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
module.exports={scanFolder,productQuery};
