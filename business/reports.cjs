const Decimal=require('decimal.js');const ExcelJS=require('exceljs');const config=require('./report-config.json');
const {centerWorkbook}=require('./workbook-style.cjs');
const fields=['order_pay_amount','snapshot_refund_money'];
const reportTotals=monthly=>Object.fromEntries(fields.map(f=>[f,monthly.reduce((sum,row)=>sum.plus(money(row[f])),new Decimal(0)).toFixed(2)]));
function money(v){if(v===null||v===undefined||v==='')throw Error('报表金额缺失');const d=new Decimal(String(v).replaceAll(',',''));if(!d.isFinite())throw Error('报表金额无效');return d;}
function months(start,end){if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(start)||!/^\d{4}-(0[1-9]|1[0-2])$/.test(end)||start>end)throw Error('请选择有效的起止月份');const out=[];let [y,m]=start.split('-').map(Number);while(`${y}-${String(m).padStart(2,'0')}`<=end){const label=`${y}-${String(m).padStart(2,'0')}`;const st=Date.UTC(y,m-1,1)-8*3600000,en=Date.UTC(y,m,1)-8*3600000-1000;out.push({label,startTime:st,endTime:Math.min(en,Date.now())});if(out.length>36)throw Error('单次最多查询 36 个月');if(++m===13){y++;m=1;}}if(out.some(x=>x.startTime>Date.now()))throw Error('不能查询未来月份');return out;}
async function queryReport(start,end,request,progress){
 const monthly=[],rows=[];for(const job of months(start,end)){
  const body={...config.base,startTime:job.startTime,endTime:job.endTime,pageNo:1};
  const call=async(kind,payload=body)=>{progress(`${job.label} · ${kind==='page'?'查询店铺':kind==='summary'?'核对汇总':'准备查询'}`);const r=await request('/kmrp/statistics/history/sale/finance/'+kind,{...payload,api_name:'kmrp_statistics_history_sale_finance_'+kind});if(r.suc!==true)throw Error('报表接口未返回成功状态');return r.data;};
  await call('sniff');const data=await call('page');const summary=await call('summary');
  if(!Array.isArray(data?.list)||data.page?.hasNext!==false)throw Error('报表分页未完整返回，停止导出');
  if(!summary||Number(summary.total)!==data.list.length)throw Error('报表条数与汇总不一致');
  const known=new Set(config.shops.map(x=>String(x.id))),byId=new Map();
  for(const row of data.list){const id=String(row.user_id);if(!known.has(id)||byId.has(id))throw Error('返回了未知或重复店铺');byId.set(id,row);}
  // Missing stores must be explicitly confirmed to contain no records, never assumed zero.
  for(const shop of config.shops.filter(s=>!byId.has(String(s.id)))){const zero=await call('summary',{...body,userIdList:String(shop.id)});if(Number(zero?.total)!==0)throw Error('缺失店铺存在记录，不能按零汇总');}
  const total={month:job.label};for(const f of fields){const sum=data.list.reduce((n,r)=>n.plus(money(r[f])),new Decimal(0));if(!sum.eq(money(summary.amount?.[f])))throw Error('店铺金额与月度汇总不一致');total[f]=sum.toFixed(2);}
  monthly.push(total);for(const shop of config.shops){const src=byId.get(String(shop.id));rows.push({month:job.label,title:shop.title,platform:shop.source,...Object.fromEntries(fields.map(f=>[f,src?money(src[f]).toFixed(2):'0.00']))});}
 }
 return {start,end,monthly,rows,totals:reportTotals(monthly),queriedAt:new Date().toISOString(),shops:config.shops.length};
}
async function exportReport(data,file){
 const wb=new ExcelJS.Workbook();const s=wb.addWorksheet('月度汇总',{views:[{state:'frozen',xSplit:1,ySplit:5}]});const last=data.monthly.length+2;
 s.mergeCells(2,1,2,last);s.getCell(2,1).value=`${data.start} 至 ${data.end} 金额汇总`;
 s.mergeCells(3,1,3,last);s.getCell(3,1).value=`${data.shops} 家店铺 · 金额单位：元 · 查询时间：${new Date(data.queriedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}`;
 s.getRow(5).values=['统计指标',...data.monthly.map(x=>x.month),'合计'];
 for(let i=0;i<2;i++){const f=fields[i],r=6+i;s.getRow(r).values=[['订单买家已付金额','退款金额'][i],...data.monthly.map(x=>Number(x[f]))];s.getCell(r,last).value={formula:`SUM(B${r}:${s.getColumn(last-1).letter}${r})`,result:Number(data.monthly.reduce((n,x)=>n.plus(x[f]),new Decimal(0)).toFixed(2))};}
 s.mergeCells(9,1,9,last);s.getCell(9,1).value='订单按创建时间；退款按售后完成时间。当前月统计截至本次查询。';
 s.getColumn(1).width=28;for(let c=2;c<=last;c++)s.getColumn(c).width=18;
 for(let r=5;r<=7;r++){s.getRow(r).height=32;for(let c=1;c<=last;c++){const cell=s.getCell(r,c);cell.font={name:'Microsoft YaHei',size:11,color:{argb:r===5?'FFFFFFFF':'FF28313D'},bold:r===5||c===1};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:r===5?'FF233F5B':r===7?'FFF3F6FA':'FFFFFFFF'}};cell.border={bottom:{style:'thin',color:{argb:'FFDCE2EA'}}};if(r>5&&c>1)cell.numFmt='#,##0.00';}}
 const detail=wb.addWorksheet('店铺月度明细');detail.addRow(['月份','店铺','平台','订单买家已付金额','退款金额']);for(const r of data.rows)detail.addRow([r.month,r.title,r.platform,Number(r.order_pay_amount),Number(r.snapshot_refund_money)]);detail.columns.forEach(c=>c.width=25);
 centerWorkbook(wb);
 await wb.xlsx.writeFile(file);const check=new ExcelJS.Workbook();await check.xlsx.readFile(file);if(check.worksheets[1].rowCount!==data.rows.length+1)throw Error('导出回读校验失败');
}
module.exports={months,queryReport,exportReport,reportTotals};
