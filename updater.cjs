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
    try { req=https.get(secureURL(url),{headers:{'User-Agent':'ZSZ-Tools-Updater','Accept':'application/json'}},res=>{
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
  if (typeof manifest.tag_name === 'string') manifest = githubManifest(manifest);
  if(!newer(manifest.version,current))return {status:'current',current};
  const download=manifest.downloads?.[`${platform}-${arch}`];
  return {status:download?'available':'unsupported',current,latest:manifest.version,notes:typeof manifest.notes==='string'?manifest.notes.slice(0,10000):'',download:download?secureURL(download):null};
}
function githubManifest(release) {
  if(release.draft || release.prerelease || !Array.isArray(release.assets))throw new Error('更新信息不是正式发布版本');
  const version=release.tag_name.replace(/^v/,'');versionParts(version);
  const downloads={};
  for(const [target,suffix] of Object.entries({'darwin-arm64':'mac-arm64.dmg','darwin-x64':'mac-x64.dmg','win32-x64':'win-x64.exe','win32-arm64':'win-arm64.exe'})) {
    const expectedNames=new Set([`钊叔工具箱-${version}-${suffix}`,`-${version}-${suffix}`]);
    const matches=release.assets.filter(a=>expectedNames.has(a.name));
    if(matches.length>1)throw new Error('更新安装包重复');
    if(matches.length){const url=new URL(secureURL(matches[0].browser_download_url));if(url.hostname!=='github.com'||!url.pathname.startsWith('/xyq20/ZSZ-Tools/releases/download/'))throw new Error('安装包不属于工具箱发布仓库');downloads[target]=url.href;}
  }
  return {version,notes:release.body||'',downloads};
}
module.exports={fetchManifest,evaluateManifest,newer,githubManifest};
