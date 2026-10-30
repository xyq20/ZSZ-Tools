const views=['home','report','price','monthly','taobao'];
const labels={home:'全部工具',report:'丹姐表格',price:'批量导入价格',monthly:'总表（双姐）',taobao:'淘宝素材上传（谭）'};
for(const button of document.querySelectorAll('[data-view]'))button.addEventListener('click',()=>{
const name=button.dataset.view;for(const id of views)document.getElementById(id).hidden=id!==name;
document.getElementById('crumb').textContent=labels[name];
for(const nav of document.querySelectorAll('aside button'))nav.classList.toggle('active',nav.dataset.view===name);
});
document.getElementById('search').addEventListener('input',e=>{let visible=0;for(const card of document.querySelectorAll('[data-search]')){card.hidden=!card.dataset.search.toLowerCase().includes(e.target.value.trim().toLowerCase());if(!card.hidden)visible++;}document.getElementById('empty').hidden=visible>0;});
const checkButton=document.getElementById('check-update');
const downloadButton=document.getElementById('download-update');
const updateStatus=document.getElementById('update-status');
window.desktop?.getVersion().then(v=>document.getElementById('app-version').textContent='v'+v+' · 桌面版').catch(()=>{});
const updateDialog=document.getElementById('update-dialog');
document.getElementById('close-update').addEventListener('click',()=>updateDialog.close());
checkButton.addEventListener('click',async()=>{
 updateDialog.showModal();
 checkButton.disabled=true;checkButton.textContent='正在检查…';downloadButton.hidden=true;
 const notes=document.getElementById('update-notes');notes.hidden=true;updateStatus.textContent='正在连接更新服务…';
 try{
  if(!window.desktop)throw new Error('请在桌面软件中检查更新。');
  const r=await window.desktop.checkUpdate();
  const messages={unconfigured:'尚未配置更新服务。发布地址配置完成后，即可在这里检查新版。',current:'当前已是最新版本（v'+r.current+'）。',available:'发现新版本 v'+r.latest+'，当前版本 v'+r.current+'。是否前往下载？',unsupported:'发现新版本 v'+r.latest+'，但当前系统或芯片的安装包尚未发布。',error:r.message};
  updateStatus.textContent=messages[r.status]||'更新服务返回了未知状态。';
  if(r.notes){notes.textContent=r.notes;notes.hidden=false;}
  downloadButton.hidden=r.status!=='available';
 }catch(e){updateStatus.textContent=e.message||'检查失败，请稍后重试。';}
 finally{checkButton.disabled=false;checkButton.textContent='↻　检查更新';}
});
downloadButton.addEventListener('click',async()=>{try{await window.desktop.downloadUpdate();updateDialog.close();}catch{updateStatus.textContent='无法打开下载地址，请重新检查更新。';}});

let hasTaobaoFolder=false,taobaoReady=false;
let busy=false,hasBook=false,hasPrices=false,hasFillablePrices=false,hasReport=false,hasMonthlyBook=false,hasMonthlyPreview=false,hasMonthlyReport=false,canSaveMonthly=false;
const statusFor=tool=>document.getElementById(tool+'-progress');
function refreshActions(){for(const b of document.querySelectorAll('[data-job]'))b.disabled=busy;document.getElementById('taobao-prepare').disabled=busy||!hasTaobaoFolder;document.getElementById('taobao-publish').disabled=busy||!taobaoReady;document.getElementById('price-query').disabled=busy||!hasBook;document.getElementById('price-save').disabled=busy||!hasFillablePrices;document.getElementById('price-export').disabled=busy||!hasPrices;document.getElementById('report-export').disabled=busy||!hasReport;for(const [id,ready] of [['monthly-preview',hasMonthlyBook],['monthly-save',canSaveMonthly],['monthly-export',hasMonthlyPreview],['monthly-reports',hasMonthlyReport]])document.getElementById(id).disabled=busy||!ready;}
async function call(action,...args){if(!window.desktop?.business)throw Error('请在新版桌面程序中使用此功能');const r=await window.desktop.business(action,...args);if(!r.ok)throw Error(r.error);return r.data;}
async function run(tool,fn){if(busy)return;busy=true;refreshActions();try{await fn();}catch(e){statusFor(tool).textContent=e.message;}finally{busy=false;refreshActions();}}
function table(target,headers,rows,totals){const root=document.getElementById(target);root.replaceChildren();const t=document.createElement('table'),head=document.createElement('thead'),tr=document.createElement('tr');headers.forEach(x=>{const th=document.createElement('th');th.textContent=x;tr.append(th);});head.append(tr);t.append(head);const body=document.createElement('tbody');for(const row of rows){const r=document.createElement('tr');for(const value of row){const cell=document.createElement('td');cell.textContent=value??'';r.append(cell);}body.append(r);}t.append(body);if(totals){const foot=document.createElement('tfoot'),r=document.createElement('tr');totals.forEach((value,i)=>{const cell=document.createElement(i===0?'th':'td');if(i===0)cell.scope='row';cell.textContent=value;r.append(cell);});foot.append(r);t.append(foot);}root.append(t);}
window.desktop?.onProgress(p=>{statusFor(p.tool).textContent=p.message;});
for(const button of document.querySelectorAll('[data-login]'))button.addEventListener('click',async()=>{const tool=button.dataset.login;try{await call('login',tool);statusFor(tool).textContent='请在登录窗口完成登录，返回后点击查询。';}catch(e){statusFor(tool).textContent=e.message;}});
document.getElementById('choose').addEventListener('click',()=>run('price',async()=>{const b=await call('choose');if(!b)return;hasBook=true;hasPrices=false;hasFillablePrices=false;document.getElementById('book').textContent=`${b.name} · ${b.sheet} · ${b.rows} 行`;document.getElementById('price-results').replaceChildren();statusFor('price').textContent=`文件已读取：待补价格 ${b.pending} 行，已有内容或公式 ${b.skipped} 行将跳过。`;}));
document.getElementById('price-query').addEventListener('click',()=>run('price',async()=>{hasPrices=false;hasFillablePrices=false;document.getElementById('price-results').replaceChildren();statusFor('price').textContent='开始查询空白价格…';const rows=await call('price-query');hasPrices=true;table('price-results',['行','货号','商品名称','原价格','淘宝价格','状态','说明'],rows.map(r=>[r.row,r.code,r.name,r.original,r.price,r.status,r.reason]));const n=rows.filter(r=>r.status==='待填入').length,skipped=rows.filter(r=>['已有价格','公式保留'].includes(r.status)).length;hasFillablePrices=n>0;statusFor('price').textContent=`核对完成：跳过 ${skipped} 行，${n} 行可补价格，${rows.length-skipped-n} 行待核对。${n?'请核对结果后确认填入。':''}`;}));
document.getElementById('price-save').addEventListener('click',()=>run('price',async()=>{const r=await call('price-save');if(r){hasPrices=false;hasFillablePrices=false;statusFor('price').textContent=`已填入 ${r.count} 行空白价格并回读验证。备份：${r.backup}`;document.getElementById('price-results').replaceChildren();}}));
for(const tool of ['price','report'])document.getElementById(tool+'-export').addEventListener('click',()=>run(tool,async()=>{const file=await call(tool+'-export');if(file)statusFor(tool).textContent='已导出：'+file;}));
const now=new Date(),month=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;document.getElementById('start').value=now.getFullYear()+'-01';document.getElementById('end').value=month;
document.getElementById('report-query').addEventListener('click',()=>run('report',async()=>{hasReport=false;document.getElementById('report-results').replaceChildren();statusFor('report').textContent='开始查询…';const r=await call('report-query',document.getElementById('start').value,document.getElementById('end').value);hasReport=true;table('report-results',['月份','订单买家已付金额','退款金额'],r.monthly.map(x=>[x.month,x.order_pay_amount,x.snapshot_refund_money]),['合计',r.totals.order_pay_amount,r.totals.snapshot_refund_money]);statusFor('report').textContent=`${r.shops} 家店铺、${r.monthly.length} 个月，金额核对通过。查询时间：${new Date(r.queriedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}`;}));
refreshActions();

const monthlyDate=document.getElementById('monthly-date');
monthlyDate.value=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function monthlyPlan(plan){
 document.getElementById('monthly-book').textContent=plan.file;
 const c=plan.cycle;
 document.getElementById('monthly-cycle').textContent=`本次节点：${c.nodeDate} · 实发数量：${c.actualWindow.join(' 至 ')} · 三类退货率：${c.returnWindow.join(' 至 ')} · 保存名称：${plan.targetName}`;
}
function clearMonthlyPreview(){hasMonthlyPreview=false;hasMonthlyReport=false;canSaveMonthly=false;document.getElementById('monthly-results').replaceChildren();}
document.getElementById('monthly-choose').addEventListener('click',()=>run('monthly',async()=>{
 const plan=await call('monthly-choose',monthlyDate.value);if(!plan)return;clearMonthlyPreview();hasMonthlyBook=true;monthlyPlan(plan);statusFor('monthly').textContent='总表已读取。请确认日期范围，再查询并预览。';
}));
monthlyDate.addEventListener('change',()=>{if(!hasMonthlyBook)return;return run('monthly',async()=>{clearMonthlyPreview();monthlyPlan(await call('monthly-plan',monthlyDate.value));statusFor('monthly').textContent='日期范围已更新，请重新查询并预览。';});});
const monthlyStatus=value=>({exact:'精确匹配',alias:'已确认别名',unmatched:'未匹配',ambiguous:'匹配不唯一',review:'待核对',invalid:'数据无效',below_threshold:'销售不足 50',missing:'缺失',missing_value:'缺少数值',invalid_actual:'实发数量无效',invalid_value:'数据无效'}[value]||value||'');
const monthlyRate=value=>value==null||value===''?'':Number.isFinite(Number(value))?new Intl.NumberFormat('zh-CN',{style:'percent',minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(value)):value;
document.getElementById('monthly-preview').addEventListener('click',()=>run('monthly',async()=>{
 clearMonthlyPreview();statusFor('monthly').textContent='正在读取总表并准备查询…';
 const result=await call('monthly-preview',monthlyDate.value),s=result.summary;
 hasMonthlyPreview=true;hasMonthlyReport=true;canSaveMonthly=s.canSave;
 document.getElementById('monthly-book').textContent=s.sourceWorkbook;
 document.getElementById('monthly-cycle').textContent=`本次节点：${s.nodeDate} · 实发数量：${s.actualWindow.join(' 至 ')} · 三类退货率：${s.returnWindow.join(' 至 ')} · 保存为：${s.workbook}`;
 table('monthly-results',['行','货号','商品名称','原实发','新实发','发货前退货率','发货后退货率','总退货率','实发匹配'],result.rows.map(r=>[r.row,r.sheet_sku,r.sheet_name,r.old_actual,r.new_actual,monthlyRate(r.new_before_return),monthlyRate(r.new_after_return),monthlyRate(r.new_return),monthlyStatus(r.actual_status)]));
 statusFor('monthly').textContent=s.canSave?`预览完成：${s.rowCount} 行，${s.manualReviewRows} 项待核对；关键货号与工作簿校验通过。确认后备份并更新总表。`:`预览完成：${s.rowCount} 行，${s.criticalFailures} 个关键货号校验未通过。请导出核对明细查看原因，原表保留。`;
}));
document.getElementById('monthly-save').addEventListener('click',()=>run('monthly',async()=>{
 const result=await call('monthly-save');if(!result)return;hasMonthlyBook=false;hasMonthlyPreview=false;canSaveMonthly=false;document.getElementById('monthly-book').textContent=result.workbook;statusFor('monthly').textContent=`总表已更新，图片与公式校验通过。备份：${result.backup}`;
}));
document.getElementById('monthly-export').addEventListener('click',()=>run('monthly',async()=>{const file=await call('monthly-export');if(file)statusFor('monthly').textContent='已导出核对明细：'+file;}));
document.getElementById('monthly-reports').addEventListener('click',()=>run('monthly',()=>call('monthly-reports')));
refreshActions();

for(const action of ['settings','save-key','login','choose','prepare','publish','history'])document.getElementById('taobao-'+action).addEventListener('click',()=>run('taobao',async()=>{
 if(action==='settings'||action==='save-key'){
  const r=await call('taobao-'+action,...(action==='save-key'?[document.getElementById('taobao-key').value]:[]));
  document.getElementById('taobao-key').value='';document.getElementById('taobao-config-status').textContent=`模型：${r.model} · 密钥：${r.hasKey?'已配置':'未配置'} · 浏览器：${r.browser||'请安装 Chrome 或 Edge'}`;return;
 }
 if(action==='login'){const r=await call('taobao-login');statusFor('taobao').textContent=r.message;return;}
 if(action==='choose'){
  const r=await call('taobao-choose');if(!r)return;taobaoReady=false;hasTaobaoFolder=true;
  document.getElementById('taobao-folder').textContent=`${r.folder} · ${r.rows.length} 条视频 · 跳过已处理 ${r.skipped} 条`;
  table('taobao-results',['文件','匹配词','记录状态'],r.rows.map(x=>[x.file,x.query,tbStatus(x.status)]));statusFor('taobao').textContent='目录已读取，请确认淘宝店铺后点击上传、生成并核验。';return;
 }
 if(action==='prepare'){
  taobaoReady=false;statusFor('taobao').textContent='开始准备批次…';const r=await call('taobao-prepare');
  table('taobao-results',['视频','文案','关联商品','商品 ID','话题'],r.choices.map(x=>[x.file,x.caption,x.product_name,x.product_id,x.topic_title]));taobaoReady=r.status==='ready';return;
 }
 if(action==='publish'){
  try{const r=await call('taobao-publish');if(r){taobaoReady=false;statusFor('taobao').textContent=r.message;}}catch(e){taobaoReady=false;throw e;}return;
 }
 const rows=await call('taobao-history');table('taobao-results',['视频','提交时间','状态'],rows.map(x=>[x.file,new Date(x.at).toLocaleString('zh-CN'),tbStatus(x.status)]));
}));
function tbStatus(status){return {pending:'未提交',submitted:'已提交，待核实',unknown:'结果待核实，已锁定',published:'淘宝确认发布成功'}[status]||status;}
