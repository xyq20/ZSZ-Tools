const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const target=process.argv[2]||`${process.platform==='darwin'?'mac':'win'}-${process.arch}`;
const root=path.resolve(__dirname,'../runtimes',target),win=target==='win-x64';
if(!['win-x64','mac-arm64'].includes(target))throw Error('Unsupported runtime: '+target);
const site=path.join(root,win?'Lib/site-packages':'lib/python3.12/site-packages');
for(const file of ['playwright/sync_api/__init__.py','openpyxl/__init__.py','PIL/__init__.py','tzdata/zoneinfo/Asia/Shanghai'])if(!fs.existsSync(path.join(site,file)))throw Error('缺少 '+target+' 依赖 '+file+'；先运行 npm run prepare:sycm -- '+target);
if(win){
 const pth=fs.readFileSync(path.join(root,'python312._pth'),'utf8');if(!pth.split(/\r?\n/).includes('Lib/site-packages'))throw Error('Windows Python 搜索路径缺失');
 for(const file of ['playwright/driver/node.exe','PIL/_imaging.cp312-win_amd64.pyd','greenlet/_greenlet.cp312-win_amd64.pyd']){
  const data=fs.readFileSync(path.join(site,file));const offset=data.readUInt32LE(0x3c);
  if(data.subarray(0,2).toString()!=='MZ'||data.readUInt16LE(offset+4)!==0x8664)throw Error('不是 Windows x64 依赖：'+file);
 }
}else{
 const r=spawnSync(path.join(root,'bin/python3.12'),['-c','import playwright.sync_api, openpyxl, PIL; from zoneinfo import ZoneInfo; ZoneInfo("Asia/Shanghai")'],{stdio:'inherit'});if(r.status!==0)throw Error('Mac Python 依赖无法加载');
}
console.log('生意参谋依赖检查通过：'+target);
