const {Readable,Transform}=require('node:stream');
const {allowedURL}=require('./app-update.cjs');
const MANIFEST='https://api.github.com/repos/xyq20/ZSZ-Tools/releases/latest';
function updateURLAllowed(url){try{return url===MANIFEST||!!allowedURL(url);}catch{return false;}}
function createUpdateNetwork(session,{idleTimeout=60000}={}){
 // An isolated, non-persistent session uses the OS proxy without any business cookies.
 session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!updateURLAllowed(details.url)}));
 async function request(url,signal,{manifest=false}={}){
  if(manifest?url!==MANIFEST:!allowedURL(url,true))throw Error('更新地址无效');
  const controller=new AbortController();let timer,finished=false;
  const reset=()=>{clearTimeout(timer);timer=setTimeout(()=>controller.abort(Error('下载连接长时间无响应，请重试')),idleTimeout);};
  const abort=()=>controller.abort(signal.reason);
  const cleanup=()=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);};
  if(signal?.aborted)throw signal.reason;
  signal?.addEventListener('abort',abort,{once:true});reset();
  try{
   const res=await session.fetch(url,{signal:controller.signal,redirect:'follow',credentials:'omit',cache:'no-store',headers:{'User-Agent':'ZSZ-Tools-Updater','Accept':manifest?'application/json':'application/octet-stream'}});
   if(res.status!==200||!res.body)throw Error('下载失败：HTTP '+res.status);
   const body=Readable.fromWeb(res.body);
   const output=new Transform({transform(chunk,encoding,done){reset();done(null,chunk);}});
   const fail=error=>output.destroy(controller.signal.aborted?controller.signal.reason:error);
   body.on('error',fail);
   output.once('end',cleanup);
   output.once('close',()=>{cleanup();controller.abort();body.destroy();});
   body.pipe(output);return output;
  }catch(error){cleanup();throw controller.signal.aborted?controller.signal.reason:error;}
 }
 return {
  response:(url,signal)=>request(url,signal),
  async route(url){const proxy=await session.resolveProxy(url);return proxy==='DIRECT'?'direct':'system-proxy';},
  async manifest(url){const stream=await request(url,undefined,{manifest:true});let size=0;const chunks=[];try{for await(const chunk of stream){size+=chunk.length;if(size>262144)throw Error('更新信息过大');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{stream.destroy();}},
 };
}
module.exports={createUpdateNetwork,updateURLAllowed};
