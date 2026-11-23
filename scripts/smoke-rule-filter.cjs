const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');

async function check() {
  const project = path.resolve(__dirname, '..');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-rule-filter-'));
  const rules = ['拼多多', '夏一同步库存', '白胖不补款式', '格子衫（NRL089）'].map((name,index) => ({
    number:index+1, name, priority:40-index, manual_status:index===2?'停用':'启用',
    effective_status:'生效中', created_at:'2026-02-02', result:'',
  }));
  const preload = path.join(dir,'preload.cjs');
  const main = path.join(dir,'main.cjs');
  await fs.writeFile(preload,`const {contextBridge,ipcRenderer}=require('electron');
    contextBridge.exposeInMainWorld('desktop',{
      business:(...args)=>ipcRenderer.invoke('fixture',...args),onBusy:()=>{},onProgress:()=>{},onUpdate:()=>{},
      updateState:async()=>({status:'idle'}),getVersion:async()=>'0.4.50',mainWindowReady:async()=>{}
    });`);
  await fs.writeFile(main,`const {app,BrowserWindow,ipcMain}=require('electron');
    app.setPath('userData',${JSON.stringify(dir)});
    const rules=${JSON.stringify(rules)}; global.selections=[];
    ipcMain.handle('fixture',(_event,id,numbers)=>{
      let data=null;
      if(id==='ops-snapshot')data={logins:[],activity:[],errors:[],tools:{},runtime:{}};
      if(id==='erp-stock-rules-list')data=rules;
      if(id==='erp-stock-rules-preview'){global.selections.push(numbers);data={complete:true,rows:numbers.map(number=>({number,status:'已核对并取消'}))};}
      return {ok:true,data};
    });
    app.whenReady().then(()=>{global.win=new BrowserWindow({show:false,width:1280,height:820,webPreferences:{preload:${JSON.stringify(preload)}}});global.win.loadFile(${JSON.stringify(path.join(project,'app/index.html'))});});`);
  const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  let desktop;
  try {
    for(const file of [main,preload]) require('node:child_process').execFileSync(process.execPath,['--check',file]);
    desktop=await _electron.launch({executablePath:require('electron'),args:[main],env});
    const page=await desktop.firstWindow();
    page.setDefaultTimeout(8000);
    assert.equal(await page.locator('#home-title').textContent(),'项目总览');
    assert.equal(await page.locator('aside .nav-tool').count(),10);
    await page.locator('[data-owner-filter="谭"]').click();
    assert.equal(await page.locator('#home article:visible').count(),3);
    for(const link of await page.locator('aside .nav-tool').all()){
      const id=await link.getAttribute('data-view');
      await link.click();
      assert(await page.locator('#'+id).isVisible());
    }
    await page.locator('aside [data-view="ops"]').click();
    await page.locator('[data-ops-view="machine"]').click();
    assert(await page.locator('#ops-summary').isVisible());
    await page.locator('aside [data-view=erp-stock-rules]').click();
    await page.getByRole('button',{name:'读取规则',exact:true}).click();
    const search=page.getByRole('textbox',{name:'搜索规则'}).or(page.getByRole('searchbox',{name:'搜索规则'}));
    await search.waitFor();
    const first=page.locator('#erp-stock-rules-table tr:visible input');
    await first.nth(1).check();
    await search.fill('ｎｒｌ０８９');
    assert.equal(await first.count(),1);
    await first.nth(0).check();
    await page.getByText(/其中 1 条在筛选外/).first().waitFor();
    await search.fill('2');
    assert(await first.first().isChecked());
    await page.getByRole('button',{name:'预检所选规则（不上传）'}).click();
    await page.getByText(/已预览 2 条规则/).first().waitFor();
    assert.deepEqual(await desktop.evaluate(()=>global.selections.at(-1)),[2,4]);
    await search.fill('无此规则');
    await page.getByText('没有匹配的规则',{exact:false}).first().waitFor();
    assert.equal(await first.count(),0);
    await search.fill('');
    assert.equal(await first.count(),4);
    assert(await first.nth(1).isChecked());
    assert(await first.nth(2).isDisabled());
    assert(await first.nth(3).isChecked());
    console.log('项目总览与库存规则通过：名称、全半角、编号、无结果、跨筛选勾选、预检回读。');
  } finally {
    if(desktop) await desktop.close();
    await fs.rm(dir,{recursive:true,force:true});
  }
}
check().catch(error=>{console.error(error);process.exitCode=1;});
