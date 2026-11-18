const {test}=require('node:test'),assert=require('node:assert/strict');
const {createUpdateNetwork,updateURLAllowed}=require('../business/update-network.cjs');
const url='https://github.com/xyq20/ZSZ-Tools/releases/download/v0.4.21/-0.4.21-mac-arm64.dmg';
function fake(fetch){const s={fetch,resolveProxy:async()=> 'PROXY 127.0.0.1:7897',webRequest:{onBeforeRequest:fn=>{s.guard=fn;}}};return s;}
test('update transport uses isolated Electron session and validates redirected destinations',async()=>{
 let options;const session=fake(async(u,o)=>{assert.equal(u,url);options=o;return new Response('installer');});const network=createUpdateNetwork(session);
 assert.equal(await network.route(url),'system-proxy');session.resolveProxy=async()=> 'DIRECT';assert.equal(await network.route(url),'direct');
 let cancel;session.guard({url:'https://evil.example/payload'},r=>cancel=r.cancel);assert(cancel);
 assert(updateURLAllowed('https://release-assets.githubusercontent.com/asset'));assert(!updateURLAllowed('http://github.com/file'));
 const parts=[];for await(const chunk of await network.response(url))parts.push(chunk);assert.equal(Buffer.concat(parts).toString(),'installer');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'follow');
});
test('proxy transport propagates cancellation and bounds idle connections',async()=>{
 const fetch=async(u,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 const network=createUpdateNetwork(fake(fetch),{idleTimeout:20});await assert.rejects(network.response(url),/无响应/);
 const controller=new AbortController(),pending=network.response(url,controller.signal);controller.abort(Error('user cancelled'));await assert.rejects(pending,/user cancelled/);
});
test('proxy transport aborts stalled response bodies and rejects oversized update metadata',async()=>{
 const s=fake(async(u,{signal})=>new Response(new ReadableStream({start(c){signal.addEventListener('abort',()=>c.error(signal.reason),{once:true});}})));
 const network=createUpdateNetwork(s,{idleTimeout:20});await assert.rejects(async()=>{for await(const c of await network.response(url)){}},/无响应/);
 const large=createUpdateNetwork(fake(async()=>new Response('a'.repeat(262145))));await assert.rejects(large.manifest('https://api.github.com/repos/xyq20/ZSZ-Tools/releases/latest'),/过大/);
});
