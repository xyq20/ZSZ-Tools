// Install target-specific wheels into the private runtime, without executing foreign binaries.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const target=process.argv[2]||`${process.platform==='darwin'?'mac':'win'}-${process.arch}`;
if(!['mac-arm64','win-x64'].includes(target))throw Error('支持 mac-arm64 或 win-x64');
const runtime=path.join(root,'runtimes',target);
const python=process.env.SYCM_BUILD_PYTHON||(process.platform==='darwin'?path.join(root,'runtimes/mac-arm64/bin/python3.12'):'python');
const deps=['playwright==1.56.0','openpyxl==3.1.5','Pillow==11.3.0','tzdata==2025.2','pyee==13.0.1','greenlet==3.2.4','typing_extensions==4.15.0','et_xmlfile==2.0.0'];
const destination=target==='win-x64'?path.join(runtime,'Lib/site-packages'):path.join(runtime,'lib/python3.12/site-packages');
if(!fs.existsSync(path.join(runtime,target==='win-x64'?'python.exe':'bin/python3.12')))throw Error('请先执行 prepare:runtimes');
const args=['-m','pip','install','--upgrade','--only-binary=:all:','--target',destination,...(target==='win-x64'?['--platform','win_amd64','--python-version','3.12','--implementation','cp','--abi','cp312']:[]),...deps];
const r=spawnSync(python,args,{stdio:'inherit'});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status||1);
if(target==='win-x64')fs.writeFileSync(path.join(runtime,'python312._pth'),'python312.zip\n.\nLib/site-packages\n');
const metadata={target,python:'3.12',dependencies:deps};fs.writeFileSync(path.join(runtime,'sycm-dependencies.json'),JSON.stringify(metadata,null,2));
console.log('生意参谋运行依赖已准备：'+target);
