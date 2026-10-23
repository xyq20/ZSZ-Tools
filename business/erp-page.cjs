const erpOrigin=url=>{try{const u=new URL(url);return u.protocol==='https:'&&!u.port&&/^(?:erp[a-z]?|viperp)\.superboss\.cc$/.test(u.hostname)?u.origin:null;}catch{return null;}};
function validatePayload(payload,form=false){
 if(!payload||typeof payload!=='object')throw Error('未返回有效数据，请先登录对应快麦账号');
 if(payload.result===901)throw Error('登录已过期，请重新登录后查询');
 if(payload.result!==1&&!(form&&payload.suc===true))throw Error('查询未成功：'+String(payload.message||payload.msg||payload.errorMsg||'接口未返回成功状态，请稍后重试').slice(0,160));
 return payload;
}
async function waitForPage(win){
 const deadline=Date.now()+30000;let stableUrl='',stableSince=0;
 while(Date.now()<deadline){
  if(win.isDestroyed())throw Error('登录窗口已关闭，请重新查询');
  const url=win.webContents.getURL();
  if(win.webContents.isLoading()||!erpOrigin(url)){stableUrl='';stableSince=0;}
  else if(url!==stableUrl){stableUrl=url;stableSince=Date.now();}
  else if(Date.now()-stableSince>=700)return;
  await new Promise(r=>setTimeout(r,150));
 }
 throw Error('快麦页面尚未准备好，请完成登录后重试');
}
async function requestInErpPage(win,route,body){
 if(route!=='/report/sale/dimensions/list')throw Error('不支持的总表接口');
 await waitForPage(win);
 // Use the ERP page's own fetch and session, matching the original desktop script.
 // Remote content never receives a preload, Node access, or desktop IPC.
 const input=JSON.stringify({route,body:new URLSearchParams(body).toString()});
 const result=await win.webContents.executeJavaScript(`(async()=>{
  if(!/^https:\\/\\/(?:erp[a-z]?|viperp)\\.superboss\\.cc$/.test(location.origin))throw Error('请先完成快麦 ERP 登录');
  const input=${input};
  const response=await fetch(input.route,{method:'POST',credentials:'include',headers:{Accept:'application/json, text/plain, */*','Content-Type':'application/x-www-form-urlencoded',Companyid:'111873','Module-Path':'/report/sale_multidimension_next/',Trackid:'trackid'+Date.now()+'_toolkit'},body:input.body,signal:AbortSignal.timeout(120000)});
  let payload;try{payload=await response.json();}catch{throw Error('未返回有效数据，请先登录快麦 ERP');}
  return {ok:response.ok,status:response.status,payload};
 })()`,true);
 if(!result.ok)throw Error(`接口 HTTP ${result.status}，请确认登录后重试`);
 return validatePayload(result.payload,true);
}
module.exports={erpOrigin,validatePayload,waitForPage,requestInErpPage};
