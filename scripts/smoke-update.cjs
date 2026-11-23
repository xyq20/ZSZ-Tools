const {_electron}=require('playwright-core'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'toolkit-update-ui-')),project=path.resolve(__dirname,'..');let electron;
 const bootstrap=path.join(directory,'main.cjs');
 await fs.writeFile(bootstrap,`
const {app}=require('electron');app.setPath('appData',${JSON.stringify(directory)});app.getVersion=()=> '0.4.19';
const m=require(${JSON.stringify(path.join(project,'business/app-update.cjs'))}),original=m.createUpdater;
m.createUpdater=o=>original({...o,prepare:async({directory})=>{await new Promise(r=>setTimeout(r,500));return {staged:require('node:path').join(directory,'stage')};},fetchRelease:async()=>({tag_name:'v0.4.20',body:'更新日志测试',assets:[{name:'-0.4.20-mac-arm64.dmg',browser_download_url:'https://github.com/xyq20/ZSZ-Tools/releases/download/v0.4.20/-0.4.20-mac-arm64.dmg',size:10,digest:'sha256:'+'a'.repeat(64)}]}),downloader:async(info,file,{signal,onProgress})=>{for(let i=1;i<=10;i++){await new Promise(r=>setTimeout(r,100));if(signal.aborted)throw Error('cancelled');onProgress(i,10);}}});
require(${JSON.stringify(path.join(project,'main.cjs'))});
`);
 try{
 electron=await _electron.launch({executablePath:require('electron'),args:[bootstrap],env:{...process.env,ELECTRON_RUN_AS_NODE:''}});
 const page=await electron.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 // Sample a white part of the toolbar, outside the dialog and its shadow.
 const sharp=require('sharp');
 async function toolbarPixel(){
  const image=await page.screenshot({scale:'css',clip:{x:220,y:4,width:1,height:1}});
  return [...await sharp(image).extract({left:0,top:0,width:1,height:1}).removeAlpha().raw().toBuffer()];
 }
 const initial=await toolbarPixel();
 await page.locator('#check-update').click();await page.locator('#download-update').waitFor({state:'visible'});
 const shaded=await toolbarPixel();
 assert(initial.every(channel=>channel>=235));
 const dimming=initial.map((value,i)=>value-shaded[i]);
 assert(dimming.every(delta=>delta>=18&&delta<=28) && Math.max(...dimming)-Math.min(...dimming)<=1,`expected a light neutral overlay: ${initial} → ${shaded}`);
 await page.keyboard.press('Escape');
 assert(await page.locator('#update-dialog').isHidden());
 assert.deepEqual(await toolbarPixel(),initial);
 console.log('Toolbar before / during / after dialog:', initial, shaded, initial);
 await page.locator('#check-update').click();await page.locator('#download-update').waitFor({state:'visible'});
 assert.equal(await page.locator('#update-notes-details').getAttribute('open'),null);
 await page.locator('#download-update').click();await page.locator('#cancel-update').waitFor({state:'visible'});assert(await page.locator('#update-progress-bar').isVisible());await page.locator('#cancel-update').click();await page.locator('#update-status').filter({hasText:'下载已取消'}).waitFor();
 await page.locator('#download-update').click();await page.locator('#update-status').filter({hasText:'后台准备'}).waitFor();assert(await page.locator('#install-update').isHidden());await page.locator('#close-update').click();await page.locator('#check-update').click();await page.locator('#install-update').waitFor({state:'visible'});assert(await page.locator('#update-status').textContent().then(x=>x.includes('新版已准备好')));assert.equal(await page.locator('#update-progress-bar').getAttribute('value'),'100');assert.equal(await page.locator('#update-notes-details').getAttribute('open'),null);await page.locator('#update-notes-details summary').click();assert(await page.locator('#update-notes').isVisible());
 await page.locator('#close-update').click();await page.locator('#check-update').click();assert(await page.locator('#install-update').isVisible());assert.equal(await page.locator('#update-notes-details').getAttribute('open'),null);
 await page.screenshot({path:path.join(directory,'downloaded.png')});
 await page.locator('#install-update').click();await page.locator('#update-status').filter({hasText:'已安装的工具箱'}).waitFor();assert.deepEqual(errors,[]);
 console.log('Update UI: cancel, progress, downloaded state retained, install gate verified; '+directory);
 }finally{if(electron)await electron.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
