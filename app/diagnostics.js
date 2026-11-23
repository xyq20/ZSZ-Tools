function setupDiagnostics({request,toast}) {
  const find = id => document.getElementById(id);
  const tools = new Map([...document.querySelectorAll('aside .nav-tool')].map(nav=>[
    nav.dataset.view, {name:nav.textContent,owner:nav.closest('.nav-owner-group').querySelector('strong').textContent},
  ]));
  const visible=()=>!find('ops').hidden;
  let view = 'attention';
  let selected = '';
  let job = null;
  let jobSourceReady = false;
  let jobMessage = '';
  let update = null;
  let snapshot = null;
  let load = null;
  let snapshotFailed = false;

  const element = (tag, text, className) => {
    const result = document.createElement(tag);
    if (text != null) result.textContent = text;
    if (className) result.className = className;
    return result;
  };
  const button = (text, className) => {
    const result = element('button', text, className);
    result.type = 'button';
    return result;
  };
  function destination(id, text, className, focus) {
    const result = button(text, className);
    result.dataset.view = id;
    if (focus) result.dataset.focus = focus;
    return result;
  }
  const toolName = id => tools.get(id)?.name || '工具箱';
  const timeFormat = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const showTime = value => value && Number.isFinite(new Date(value).getTime()) ? timeFormat.format(new Date(value)) : '';
  const loginStates = {present:'有本机记录',missing:'未找到记录',configured:'已配置',unknown:'待确认'};
  const machineIssueNames = {update:'软件更新',python:'内置 Python',browser:'浏览器',encryption:'系统加密'};
  const trackedActions = new Set([
    'report-query','report-export','price-query','price-save','price-export','monthly-preview','monthly-save','monthly-export',
    'return-rate-start','taobao-prepare','taobao-publish','taobao-soutu-scan','taobao-soutu-plan','taobao-soutu-publish',
    'taobao-soutu-resolve','taobao-stock-start','taobao-stock-resume','taobao-reminders-run-now',
    'taobao-reminders-scheduled','taobao-reminders-preview','sycm-start','sycm-resume',
  ]);

  function actionName(action) {
    const special = {choose:'选择 Excel',login:'登录','taobao-reminders-scheduled':'定时巡检'};
    const control = find(action);
    return special[action] || (control?.tagName === 'BUTTON' ? control.textContent.trim() : '操作');
  }

  const updateLabels = {
    idle:'尚未检查',checking:'正在检查',current:'当前已是最新版本',available:'有新版可下载',unsupported:'当前设备没有适用安装包',
    error:'检查失败',downloading:'正在下载',preparing:'正在准备新版',downloaded:'新版已就绪',installing:'正在重启更新',
  };
  function updateText() {
    return [updateLabels[update?.status] || '尚未检查',update?.latest ? 'v'+update.latest : ''].filter(Boolean).join(' · ');
  }

  function activeRecord() {
    if (!job) return null;
    return {key:'active',tool:job.tool,name:toolName(job.tool),status:'运行中',tone:'',at:job.since,
      detail:[actionName(job.action),jobMessage].filter(Boolean).join(' · '),next:'返回工具查看当前进展。'};
  }

  function issues() {
    if (!snapshot) return [];
    const {tools:state={},runtime,update} = snapshot;
    const items = [];
    const add = (key,tool,status,detail,next,focus,at) => {
      if (job?.tool===tool && tool) return;
      items.push({key,tool,status,detail,next,focus,at,name:machineIssueNames[key]||toolName(tool),tone:status==='异常'?'error':'warn'});
    };
    for (const failed of (update?.failures||[]).slice(0,1)) {
      add('update',null,'异常',['更新未完成',failed.version,failed.reason].filter(Boolean).join(' · '),
        '检查更新日志，确认原因后再重试。',null,failed.at);
    }
    if (runtime?.python?.ok===false) add('python',null,'异常','缺少内置 Python。','重新安装工具箱后检测。');
    if (runtime?.browser?.ok===false) add('browser',null,'异常','未检测到 Chrome 或 Edge。','安装常用浏览器后重新检测。');
    if (runtime?.encryption===false) add('encryption',null,'异常','系统加密当前不可用。','检查系统账户的凭证设置。');
    for (const part of runtime?.components||[]) {
      if (!part.ok) add('component-'+part.id,part.id,'异常','缺少内置运行文件。','核对本机安装是否完整。');
    }
    const soutu=state['taobao-soutu'];
    if (soutu?.records?.pending) add('soutu-pending','taobao-soutu','待核对',soutu.records.pending+' 组发布结果待确认。',
      '在千牛核对发布结果，再回工具核对待确认记录。','taobao-soutu-resolve');
    if (soutu?.staleLock) add('soutu-lock','taobao-soutu','待核对','存在本机搜推运行锁。',
      '确认是否还有其他搜推任务在执行。',null,soutu.staleLock.at);
    if (state.taobao?.records?.unknown) add('taobao-unknown','taobao','待核对',state.taobao.records.unknown+' 条发布结果未明确。',
      '到淘宝作品管理核对，再回工具查看发布记录。','taobao-history');
    const reminder=state['taobao-reminders'];
    if (reminder?.configUnreadable || reminder?.lastFailed) add('reminder','taobao-reminders','异常',
      reminder.lastMessage || '最近巡检未正常结束。','打开提醒工具核对登录和飞书设置。','taobao-reminders-login');
    const stock=state['taobao-stock']?.jobs;
    if (stock?.resumable) add('stock-resume','taobao-stock','可继续',stock.resumable+' 个近期库存任务尚未结束。',
      '确认二店账号，再点击「继续未完成任务」。','taobao-stock-resume',stock.latest?.createdAt);
    if (stock?.needsReview) add('stock-review','taobao-stock','待核对',stock.needsReview+' 个近期库存任务的记录待检查。',
      '打开库存工具，先查看简洁报告。','taobao-stock-report');
    const sycm=state.sycm?.lastTask;
    if (sycm?.incomplete || sycm?.error) add('sycm-prior','sycm','待核对',sycm.error||'上轮采集有未完成或失败项目。',
      '用「打开结果文件夹」核对记录，再决定是否继续上轮。','sycm-results',sycm.at);
    return items;
  }

  function activities() {
    if (!snapshot) return [];
    const failed = (snapshot.errors || []).filter(record=>tools.has(record.tool));
    const good = (snapshot.activity||[]).filter(record=>record.ok && trackedActions.has(record.action) && tools.has(record.tool));
    return [...failed,...good].sort((left,right)=>String(right.at).localeCompare(String(left.at))).slice(0,40).map((row,index)=>({
      key:'activity-'+row.at+'-'+row.action+'-'+index,tool:row.tool,name:toolName(row.tool),
      status:row.ok?'已有返回':'有错误记录',tone:row.ok?'neutral':'error',at:row.at,
      detail:row.ok?actionName(row.action):(row.message||actionName(row.action)),
      next:row.ok?'打开工具查看实际结果。':'根据上方记录定位问题后再重试。',
    }));
  }

  function statusPill(record) { return element('span',record.status,['status-label',record.tone].filter(Boolean).join(' ')); }

  function recordButton(record, text, className) {
    if (tools.has(record.tool)) return destination(record.tool,text,className,record.focus);
    return destination('ops',text,className,'machine');
  }

  function machineFacts() {
    const app=snapshot?.app, runtime=snapshot?.runtime;
    const browser=runtime?.browser,python=runtime?.python;
    const platform={darwin:'macOS',win32:'Windows'}[app?.platform];
    return [
      ['系统版本',[platform,app?.os,app?.arch].filter(Boolean).join(' ')||'未检测'],
      ['工具箱版本',app?.version?'v'+app.version:'未检测'],
      ['软件更新',snapshot?.update?.pending?'上次更新仍在等待确认 · '+updateText():updateText()],
      ['浏览器',browser?.ok===false?'未找到 Chrome 或 Edge':[browser?.name,browser?.version].filter(Boolean).join(' ')||'未检测'],
      ['Python',python?.ok===true?['已找到',python.version].filter(Boolean).join(' · '):python?.ok===false?'缺少内置运行环境':'未检测'],
      ['系统加密',runtime?.encryption===true?'可用':runtime?.encryption===false?'不可用':'未检测'],
      ['剩余磁盘',runtime?.diskFreeGB!=null?runtime.diskFreeGB+' GB':'未检测'],
    ];
  }

  function renderMachine() {
    find('ops-summary').replaceChildren(...machineFacts().map(([label,value])=>{
      const row=element('div');
      row.append(element('dt',label),element('dd',value));
      return row;
    }));
    find('ops-install-details').hidden=!snapshot?.logs?.install;
    find('ops-install-log').textContent=snapshot?.logs?.install||'';
    const rows=[];
    for (const entry of snapshot?.logins||[]) {
      const related=entry.tools.filter(id=>tools.has(id));
      if (!related.length) continue;
      const row=element('tr'),state=element('td'),actions=element('td');
      state.dataset.state=entry.state;
      state.append(element('strong',loginStates[entry.state]||'待确认'));
      if (entry.note) state.append(element('p',entry.note));
      for (const id of related) actions.append(destination(id,toolName(id),'button-text'));
      row.append(element('td',entry.label),state,actions);
      rows.push(row);
    }
    find('ops-logins').replaceChildren(...rows);
  }

  function renderRecord(record) {
    if (!record) {
      find('ops-task-detail').replaceChildren(element('p','请选择任务查看进展。'));
      return;
    }
    const tool=tools.get(record.tool),facts=element('dl');
    for (const [name,value] of [['进展',record.detail],['下一步',record.next]]) {
      const row=element('div');
      row.append(element('dt',name),element('dd',value));
      facts.append(row);
    }
    const header=[tool?.owner,showTime(record.at)].filter(Boolean).join(' · ');
    find('ops-task-detail').replaceChildren(statusPill(record),element('h2',record.name),element('p',header),facts,
      recordButton(record,tool?'打开相关工具':'打开本机检查','button-quiet'));
  }

  function renderOps() {
    const active=activeRecord();
    const pending=issues();
    const rows = view==='attention'?pending:[...(active?[active]:[]),...pending,...activities()];
    const version=snapshot?.app?.version;
    const scoped='当前电脑';
    const last=snapshot ? ' · 检测时间（北京） '+showTime(snapshot.generatedAt)+(snapshot.incomplete?' · 部分读取超时':'') : '';
    find('ops-status').textContent=scoped+(snapshotFailed?' · 读取失败，可重新检测':load?' · 正在读取…':last);
    const metrics=[['待处理',snapshot ? pending.length : '—'],['运行中',jobSourceReady ? Number(Boolean(active)) : '—'],['本机版本',version?'v'+version:'—']];
    find('ops-metrics').replaceChildren(...metrics.map(([label,value])=>{
      const item=element('span',label+' ');
      item.append(element('strong',value));
      return item;
    }));
    for (const tab of document.querySelectorAll('[data-ops-view]')) tab.setAttribute('aria-pressed',String(tab.dataset.opsView===view));
    find('ops-queue').hidden=view==='machine';
    find('ops-machine').hidden=view!=='machine';
    find('ops-copy').disabled=!snapshot;
    if (view==='machine') {renderMachine();return;}
    find('queue-title').textContent=view==='attention'?'待处理':'近期操作记录';
    const chosen=rows.find(row=>row.key===selected)||rows[0];
    selected=chosen?.key||'';
    const buttons=rows.map(row=>{
      const item=button(null,'a-task'),label=element('span');
      label.append(element('strong',row.name),element('small',[tools.get(row.tool)?.owner,showTime(row.at)].filter(Boolean).join(' · ')));
      item.append(label,statusPill(row));
      item.dataset.recordKey=row.key;
      item.setAttribute('aria-pressed',String(row.key===selected));
      return item;
    });
    find('ops-attention').replaceChildren(...(buttons.length?buttons:[element('p',snapshot?'当前暂无对应记录。':snapshotFailed?'读取失败，请重新检测。':'等待本机检测结果。','a-empty')]));
    renderRecord(chosen);
  }

  async function refresh() {
    if (load) return;
    load=request('ops-snapshot');
    find('ops-refresh').disabled=true;
    if (visible()) renderOps();
    try {
      const next=await load;
      if (!next || !Array.isArray(next.logins)) throw Error('诊断数据无法读取');
      snapshot=next;
      snapshotFailed=false;
    } catch {snapshotFailed=true;}
    finally {
      load=null;
      find('ops-refresh').disabled=false;
      if (visible()) renderOps();
    }
  }

  find('ops').addEventListener('click',event=>{
    const target=event.target.closest('button');
    if (!target) return;
    if (target.dataset.opsView) {view=target.dataset.opsView;renderOps();}
    if (target.dataset.recordKey) {
      selected=target.dataset.recordKey;
      renderOps();
      find('ops-attention').querySelector('[aria-pressed="true"]')?.focus({preventScroll:true});
    }
  });
  find('ops-refresh').addEventListener('click',refresh);
  find('ops-copy').addEventListener('click',async()=>{
    if (!snapshot) return;
    const lines=['钊叔工具箱诊断摘要','检测时间（北京） '+showTime(snapshot.generatedAt),
      ...machineFacts().map(([label,value])=>label+' · '+value),
      ...snapshot.logins.map(entry=>entry.label+' · '+(loginStates[entry.state]||'待确认')),
      ...issues().map(entry=>entry.name+' · '+entry.status),
      ...(snapshot.incomplete?['部分项目读取超时']:[])];
    try {await navigator.clipboard.writeText(lines.join('\n'));toast('已复制诊断摘要');}
    catch {toast('无法写入剪贴板，请重试。');}
  });

  return {
    open(focus){ if(focus==='machine')view='machine'; renderOps(); void refresh(); },
    setJob(value){
      const previous=job;
      if(previous?.tool!==value?.tool || previous?.action!==value?.action) jobMessage='';
      job=value;jobSourceReady=true;
      if(visible()){renderOps();if(previous&&!value)void refresh();}
    },
    setProgress(tool,message){if(job?.tool===tool){jobMessage=message;if(visible())renderOps();}},
    renderUpdate(value){update=value;if(visible())renderOps();}
  };
}
