const views=['home','report','price'];
const labels={home:'全部工具',report:'丹姐表格',price:'批量导入价格'};
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

let busy=false,hasBook=false,hasPrices=false,hasReport=false;
const statusFor=tool=>document.getElementById(tool+'-progress');
function refreshActions(){for(const b of document.querySelectorAll('[data-job]'))b.disabled=busy;document.getElementById('price-query').disabled=busy||!hasBook;for(const id of ['price-save','price-export'])document.getElementById(id).disabled=busy||!hasPrices;document.getElementById('report-export').disabled=busy||!hasReport;}
async function call(action,...args){if(!window.desktop?.business)throw Error('请在新版桌面程序中使用此功能');const r=await window.desktop.business(action,...args);if(!r.ok)throw Error(r.error);return r.data;}
async function run(tool,fn){if(busy)return;busy=true;refreshActions();try{await fn();}catch(e){statusFor(tool).textContent=e.message;}finally{busy=false;refreshActions();}}
function table(target,headers,rows,totals){const root=document.getElementById(target);root.replaceChildren();const t=document.createElement('table'),head=document.createElement('thead'),tr=document.createElement('tr');headers.forEach(x=>{const th=document.createElement('th');th.textContent=x;tr.append(th);});head.append(tr);t.append(head);const body=document.createElement('tbody');for(const row of rows){const r=document.createElement('tr');for(const value of row){const cell=document.createElement('td');cell.textContent=value??'';r.append(cell);}body.append(r);}t.append(body);if(totals){const foot=document.createElement('tfoot'),r=document.createElement('tr');totals.forEach((value,i)=>{const cell=document.createElement(i===0?'th':'td');if(i===0)cell.scope='row';cell.textContent=value;r.append(cell);});foot.append(r);t.append(foot);}root.append(t);}
window.desktop?.onProgress(p=>{statusFor(p.tool).textContent=p.message;});
for(const button of document.querySelectorAll('[data-login]'))button.addEventListener('click',async()=>{const tool=button.dataset.login;try{await call('login',tool);statusFor(tool).textContent='请在登录窗口完成登录，返回后点击查询。';}catch(e){statusFor(tool).textContent=e.message;}});
document.getElementById('choose').addEventListener('click',()=>run('price',async()=>{const b=await call('choose');if(!b)return;hasBook=true;hasPrices=false;document.getElementById('book').textContent=`${b.name} · ${b.sheet} · ${b.rows} 行`;document.getElementById('price-results').replaceChildren();statusFor('price').textContent='文件已读取，可以查询价格。';}));
document.getElementById('price-query').addEventListener('click',()=>run('price',async()=>{hasPrices=false;document.getElementById('price-results').replaceChildren();statusFor('price').textContent='开始查询…';const rows=await call('price-query');hasPrices=true;table('price-results',['行','货号','商品名称','原价格','淘宝价格','状态','说明'],rows.map(r=>[r.row,r.code,r.name,r.original,r.price,r.status,r.reason]));const n=rows.filter(r=>['待填入','待更新'].includes(r.status)).length;statusFor('price').textContent=`核对完成：${rows.length} 行，${n} 行可回填。请核对结果后确认。`;}));
document.getElementById('price-save').addEventListener('click',()=>run('price',async()=>{const r=await call('price-save');if(r){hasPrices=false;statusFor('price').textContent=`已回填 ${r.count} 行并回读验证。备份：${r.backup}`;document.getElementById('price-results').replaceChildren();}}));
for(const tool of ['price','report'])document.getElementById(tool+'-export').addEventListener('click',()=>run(tool,async()=>{const file=await call(tool+'-export');if(file)statusFor(tool).textContent='已导出：'+file;}));
const now=new Date(),month=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;document.getElementById('start').value=now.getFullYear()+'-01';document.getElementById('end').value=month;
document.getElementById('report-query').addEventListener('click',()=>run('report',async()=>{hasReport=false;document.getElementById('report-results').replaceChildren();statusFor('report').textContent='开始查询…';const r=await call('report-query',document.getElementById('start').value,document.getElementById('end').value);hasReport=true;table('report-results',['月份','订单买家已付金额','退款金额'],r.monthly.map(x=>[x.month,x.order_pay_amount,x.snapshot_refund_money]),['合计',r.totals.order_pay_amount,r.totals.snapshot_refund_money]);statusFor('report').textContent=`${r.shops} 家店铺、${r.monthly.length} 个月，金额核对通过。查询时间：${new Date(r.queriedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}`;}));
refreshActions();
