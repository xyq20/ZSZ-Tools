const https = require('node:https');
function versionParts(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) throw new Error('更新版本格式无效');
  return value.split('.').map(Number);
}
function newer(next, current) {
  const a=versionParts(next), b=versionParts(current);
  for(let i=0;i<3;i++) if(a[i]!==b[i]) return a[i]>b[i];
  return false;
}
function secureURL(value) {
  const u=new URL(value);
  if(u.protocol!=='https:' || u.username || u.password) throw new Error('更新地址必须为 HTTPS');
  return u.href;
}
function fetchManifest(url) {
  return new Promise((resolve,reject)=>{
    let req; const timer=setTimeout(()=>{req?.destroy();reject(new Error('检查更新超时，请稍后重试'));},10000);
    const fail=e=>{clearTimeout(timer);reject(e);};
    try { req=https.get(secureURL(url),res=>{
      if(res.statusCode!==200){res.resume();fail(new Error('更新服务暂时不可用'));return;}
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>262144){res.destroy();fail(new Error('更新信息过大'));}else chunks.push(chunk);});
      res.on('error',fail);
      res.on('end',()=>{clearTimeout(timer);try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(new Error('更新信息格式错误'));}});
    });req.on('error',fail);}catch(e){fail(e);}
  });
}
function evaluateManifest(manifest,current,platform,arch) {
  if(!manifest || typeof manifest!=='object')throw new Error('更新信息格式错误');
  if(!newer(manifest.version,current))return {status:'current',current};
  const download=manifest.downloads?.[`${platform}-${arch}`];
  return {status:download?'available':'unsupported',current,latest:manifest.version,notes:typeof manifest.notes==='string'?manifest.notes.slice(0,10000):'',download:download?secureURL(download):null};
}
module.exports={fetchManifest,evaluateManifest,newer};
