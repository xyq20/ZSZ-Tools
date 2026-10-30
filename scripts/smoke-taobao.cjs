const {_electron}=require('playwright-core'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
(async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'toolkit-taobao-ui-'));let electron;
 try{
  await fs.writeFile(path.join(temp,'红海 1.mp4'),'synthetic-video-for-read-only-scan');
  electron=await _electron.launch({executablePath:process.env.TOOLKIT_SMOKE_EXECUTABLE||require('electron'),args:process.env.TOOLKIT_SMOKE_EXECUTABLE?[]:[path.join(__dirname,'..')],env:{...process.env,ELECTRON_RUN_AS_NODE:''}});
  const page=await electron.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('button',{name:'▷　淘宝素材上传（谭）',exact:true}).click();
  assert(await page.locator('#taobao').isVisible());assert(await page.locator('#taobao-prepare').isDisabled());assert(await page.locator('#taobao-publish').isDisabled());
  await page.locator('#taobao details').evaluate(e=>e.open=true);await page.locator('#taobao-settings').click();await page.locator('#taobao-config-status').filter({hasText:'模型：deepseek-flash'}).waitFor();
  await electron.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},temp);
  await page.locator('#taobao-choose').click();await page.locator('#taobao-results').getByText('红海 1.mp4',{exact:true}).waitFor();
  assert(await page.locator('#taobao-prepare').isEnabled());assert(await page.locator('#taobao-publish').isDisabled());
  await page.screenshot({path:'/tmp/toolkit-taobao-ui.png',fullPage:true});
  assert.deepEqual(errors,[]);console.log('真实 Electron 窗口：导航、配置回读、目录扫描、表格和发布按钮门槛通过');
 }finally{if(electron)await electron.close();await fs.rm(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
