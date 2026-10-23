(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.ReportSpeed=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 async function mapMonths(jobs,worker,{concurrency=2}={}){
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>2)throw Error('月份并发数必须是 1 或 2');
  const results=new Array(jobs.length);let cursor=0,failed;
  const workers=Array.from({length:Math.min(concurrency,jobs.length)},async()=>{while(!failed){const index=cursor++;if(index>=jobs.length)return;try{results[index]=await worker(jobs[index],index);}catch(error){failed=error;}}});
  await Promise.all(workers);if(failed)throw failed;return results;
 }
 function pacedRequest(raw,{intervalMs=300,endpointIntervalMs=1800,retries=3,backoffMs=3000,onRetry=()=>{}}={}){
  let queue=Promise.resolve(),lastStart=-Infinity,cooldownUntil=0;const lastEndpoint=new Map();
  const slot=key=>{const next=queue.then(async()=>{for(;;){const wait=Math.max(lastStart+intervalMs,(lastEndpoint.get(key)??-Infinity)+endpointIntervalMs,cooldownUntil)-Date.now();if(wait<=0)break;await sleep(wait);}lastStart=Date.now();lastEndpoint.set(key,lastStart);});queue=next.catch(()=>{});return next;};
  return async(...args)=>{for(let attempt=0;;attempt++){
   await slot(args[0]);try{const result=await raw(...args);const message=String(result?.message||result?.msg||result?.errorMsg||'');if(result?.result!==1&&result?.suc!==true&&/频繁|限流|too many requests|rate limit/i.test(message))throw Object.assign(Error(message),{status:429});return result;}
   catch(error){if(attempt>=retries||!(error.status===429||/频繁|限流|too many requests|rate limit/i.test(error.message)))throw error;
    const wait=Math.max(backoffMs*2**attempt,Number(error.retryAfterMs)||0);cooldownUntil=Math.max(cooldownUntil,Date.now()+wait);onRetry(wait,attempt+1);
   }
  }};
 }
 return {mapMonths,pacedRequest};
});
