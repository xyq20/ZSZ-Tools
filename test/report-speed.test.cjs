const {test}=require('node:test'),assert=require('node:assert/strict');
const {mapMonths,pacedRequest}=require('../business/report-speed.js');
const {queryReport}=require('../business/reports.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('two month workers preserve ordering and drain active work on failure',async()=>{
 let active=0,maximum=0;const result=await mapMonths([30,2,1],async(ms,i)=>{active++;maximum=Math.max(maximum,active);await sleep(ms);active--;return i;});assert.equal(maximum,2);assert.deepEqual(result,[0,1,2]);
 let drained=false;const visited=[];await assert.rejects(mapMonths([0,1,2],async i=>{visited.push(i);if(i===0)throw Error('invalid totals');await sleep(5);drained=true;}),/invalid totals/);assert(drained);assert.deepEqual(visited,[0,1]);
});
test('per-endpoint pacing, bounded rate-limit retries and permission failures',async()=>{
 const starts=[];const request=pacedRequest(async key=>{starts.push({key,at:Date.now()});return {result:1,suc:true};},{intervalMs:2,endpointIntervalMs:20});
 await Promise.all([request('summary'),request('page'),request('summary'),request('page')]);
 for(const key of ['summary','page']){const times=starts.filter(x=>x.key===key).map(x=>x.at);assert(times[1]-times[0]>=20);}
 let calls=0;const retries=[];const limited=pacedRequest(async()=>{calls++;if(calls<3)return {result:0,suc:false,message:'操作过于频繁'};return {result:1,suc:true};},{intervalMs:0,endpointIntervalMs:0,backoffMs:2,onRetry:(ms,n)=>retries.push(n)});
 assert.equal((await limited('page')).result,1);assert.equal(calls,3);assert.deepEqual(retries,[1,2]);
 calls=0;await assert.rejects(pacedRequest(async()=>{calls++;throw Object.assign(Error('HTTP 429'),{status:429});},{intervalMs:0,endpointIntervalMs:0,backoffMs:1,retries:1})('page'),/429/);assert.equal(calls,2);
 calls=0;await assert.rejects(pacedRequest(async()=>{calls++;throw Error('权限不足');})('page'),/权限不足/);assert.equal(calls,1);
});
test('parallel report results stay in calendar and shop order with exact totals',async()=>{
 const cfg=require('../modules/report/report-config.json');let activeMonths=new Set(),maximum=0;
 const raw=async(route,body)=>{const month=new Date(body.startTime+8*3600000).getUTCMonth()+1,kind=route.split('/').pop();if(kind==='sniff'){activeMonths.add(month);maximum=Math.max(maximum,activeMonths.size);await sleep(month===1?20:1);return {suc:true};}
 const list=cfg.shops.map(s=>({user_id:String(s.id),order_pay_amount:month+'.01',snapshot_refund_money:'0.10'}));
 if(kind==='page')return {suc:true,data:{list,page:{hasNext:false}}};activeMonths.delete(month);return {suc:true,data:{total:14,amount:{order_pay_amount:(month*14+.14).toFixed(2),snapshot_refund_money:'1.40'}}};};
 const result=await queryReport('2026-01','2026-03',raw,()=>{},{intervalMs:0,endpointIntervalMs:0});assert.equal(maximum,2);assert.deepEqual(result.monthly.map(x=>x.month),['2026-01','2026-02','2026-03']);assert.equal(result.rows.length,42);assert.deepEqual(result.totals,{order_pay_amount:'84.42',snapshot_refund_money:'4.20'});assert.equal(result.rows[0].title,cfg.shops[0].title);assert.equal(result.rows[14].month,'2026-02');
});
