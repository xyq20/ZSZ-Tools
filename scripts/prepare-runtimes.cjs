const fs=require('node:fs/promises');
const path=require('node:path');
const https=require('node:https');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const JSZip=require('jszip');
const root=path.resolve(__dirname,'..');
const downloads={
 'mac-arm64':{version:'3.12.14',url:'https://github.com/astral-sh/python-build-standalone/releases/download/20260825/cpython-3.12.14%2B20260825-aarch64-apple-darwin-install_only_stripped.tar.gz',sha256:'8b0f1fa71eab7ca644e482c631807a1116fa848491051cd1c8d9429491de63a6',executable:'bin/python3.12'},
 'win-x64':{version:'3.12.10',url:'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip',sha256:require('../runtimes-manifest.json').windowsX64.sha256,executable:'python.exe'},
};
function download(url,redirects=0){return new Promise((resolve,reject)=>{
 if(redirects>8)return reject(Error('Too many runtime download redirects'));
 const request=https.get(url,{headers:{'User-Agent':'ZSZ-Tools-Build'}},response=>{
  if([301,302,303,307,308].includes(response.statusCode)){response.resume();resolve(download(new URL(response.headers.location,url).href,redirects+1));return;}
  if(response.statusCode!==200){response.resume();reject(Error('Runtime download HTTP '+response.statusCode));return;}
  let length=0;const chunks=[];response.on('data',chunk=>{length+=chunk.length;if(length>200*1024*1024)response.destroy(Error('Runtime archive too large'));else chunks.push(chunk);});response.on('error',reject);response.on('end',()=>resolve(Buffer.concat(chunks)));
 });request.setTimeout(30000,()=>request.destroy(Error('Runtime download timed out')));request.on('error',reject);
});}
(async()=>{
 for(const target of process.argv.slice(2).length?process.argv.slice(2):Object.keys(downloads)){
  const spec=downloads[target];if(!spec)throw Error('Unsupported runtime target: '+target);
  const directory=path.join(root,'runtimes',target);
  try{await fs.access(path.join(directory,spec.executable));console.log('Using cached Python '+spec.version+' for '+target);continue;}catch{}
  console.log('Downloading private Python runtime for '+target);
  const bytes=await download(spec.url);if(crypto.createHash('sha256').update(bytes).digest('hex')!==spec.sha256)throw Error('Runtime SHA-256 mismatch: '+target);
  await fs.mkdir(directory,{recursive:true});
  try{
   if(target.startsWith('mac-')){const archive=path.join(directory,'runtime.tar.gz');await fs.writeFile(archive,bytes);execFileSync('tar',['-xzf',archive,'--strip-components','1','-C',directory]);await fs.unlink(archive);}
   else{const zip=await JSZip.loadAsync(bytes);for(const file of Object.values(zip.files)){const dest=path.resolve(directory,file.name);if(!dest.startsWith(directory+path.sep))throw Error('Invalid runtime archive path');if(file.dir)await fs.mkdir(dest,{recursive:true});else{await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,await file.async('nodebuffer'));}}}
  }catch(error){await fs.rm(directory,{recursive:true,force:true});throw error;}
  console.log('Prepared '+target);
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
