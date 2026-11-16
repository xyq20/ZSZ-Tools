const {_electron}=require('playwright-core'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'toolkit-update-ui-')),project=path.resolve(__dirname,'..');let electron;
 const bootstrap=path.join(directory,'main.cjs');
 await fs.writeFile(bootstrap,`
const {app}=require('electron');app.setPath('appData',${JSON.stringify(directory)});app.getVersion=()=> '0.4.19';
const m=require(${JSON.stringify(path.join(project,'business/app-update.cjs'))}),original=m.createUpdater;
m.createUpdater=o=>original({...o,fetchRelease:async()=>({tag_name:'v0.4.20',assets:[{name:'-0.4.20-mac-arm64.dmg',browser_download_url:'https://github.com/xyq20/ZSZ-Tools/releases/download/v0.4.20/-0.4.20-mac-arm64.dmg',size:10,digest:'sha256:'+'a'.repeat(64)}]}),downloader:async(info,file,{signal,onProgress})=>{for(let i=1;i<=10;i++){await new Promise(r=>setTimeout(r,100));if(signal.aborted)throw Error('cancelled');onProgress(i,10);}}});
require(${JSON.stringify(path.join(project,'main.cjs'))});
`);
 try{
 electron=await _electron.launch({executablePath:require('electron'),args:[bootstrap],env:{...process.env,ELECTRON_RUN_AS_NODE:''}});
 const page=await electron.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.locator('#check-update').click();await page.locator('#download-update').waitFor({state:'visible'});
 await page.locator('#download-update').click();await page.locator('#cancel-update').waitFor({state:'visible'});await page.locator('#cancel-update').click();await page.locator('#update-status').filter({hasText:'下载已取消'}).waitFor();
 await page.locator('#download-update').click();await page.locator('#install-update').waitFor({state:'visible'});assert(await page.locator('#update-status').textContent().then(x=>x.includes('校验完成')));
 await page.locator('#close-update').click();await page.locator('#check-update').click();assert(await page.locator('#install-update').isVisible());
 await page.screenshot({path:path.join(directory,'downloaded.png')});
 await page.locator('#install-update').click();await page.locator('#update-status').filter({hasText:'已安装的工具箱'}).waitFor();assert.deepEqual(errors,[]);
 console.log('Update UI: cancel, progress, downloaded state retained, install gate verified; '+directory);
 }finally{if(electron)await electron.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
