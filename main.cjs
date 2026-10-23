const {app,BrowserWindow,ipcMain,dialog,shell,Menu}=require('electron');
const path=require('node:path');
app.commandLine.appendSwitch('lang','zh-CN');
app.commandLine.appendSwitch('accept-lang','zh-CN');
const {fetchManifest,evaluateManifest}=require('./updater.cjs');
const updateConfig=require('./update-config.json');
let win, approvedDownload=null, pendingCheck=null;
let business,quitting=false;
const {restoreWindow}=require('./business/windows.cjs');
app.on('activate',()=>restoreWindow(win));
// Keep one stable profile directory across development and branded installers.
app.setPath('userData',path.join(app.getPath('appData'),'team-toolkit'));
ipcMain.handle('app-version',()=>app.getVersion());
ipcMain.handle('check-update',()=>{
 if(pendingCheck)return pendingCheck;
 approvedDownload=null;
 pendingCheck=(async()=>{
  const current=app.getVersion();
  if(!updateConfig.manifestUrl)return {status:'unconfigured',current};
  try{const result=evaluateManifest(await fetchManifest(updateConfig.manifestUrl),current,process.platform,process.arch);approvedDownload=result.download;return result;}
  catch{return {status:'error',current,message:'无法获取更新，请检查网络或稍后重试。'};}
 })().finally(()=>{pendingCheck=null;});return pendingCheck;
});
ipcMain.handle('download-update',async()=>{if(!approvedDownload)throw new Error('请先检查更新');await shell.openExternal(approvedDownload);});
app.whenReady().then(()=>{
if(process.platform==='darwin')Menu.setApplicationMenu(Menu.buildFromTemplate([
 {label:'钊叔工具箱',submenu:[{label:'关于钊叔工具箱',role:'about'},{type:'separator'},{label:'隐藏钊叔工具箱',role:'hide'},{label:'隐藏其他应用',role:'hideOthers'},{label:'显示全部',role:'unhide'},{type:'separator'},{label:'退出钊叔工具箱',role:'quit'}]},
 {label:'编辑',submenu:[{label:'撤销',role:'undo'},{label:'重做',role:'redo'},{type:'separator'},{label:'剪切',role:'cut'},{label:'复制',role:'copy'},{label:'粘贴',role:'paste'},{label:'全选',role:'selectAll'}]},
 {label:'窗口',submenu:[{label:'最小化',role:'minimize'},{label:'缩放',role:'zoom'},{label:'关闭窗口',role:'close'}]}
]));
win=new BrowserWindow({width:1280,height:850,minWidth:1000,minHeight:680,backgroundColor:'#f5f6f8',title:'钊叔工具箱',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
business=require('./business/desktop.cjs').setupBusiness(win,app);
win.removeMenu();win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());win.loadFile(path.join(__dirname,'app/index.html'));
ipcMain.handle('choose-workbook',async()=>{const r=await dialog.showOpenDialog(win,{title:'选择 Excel 工作簿',buttonLabel:'打开',properties:['openFile'],filters:[{name:'Excel 工作簿',extensions:['xlsx']}]});return r.canceled?null:{name:path.basename(r.filePaths[0])};});
});
app.on('before-quit',e=>{
 if(!business||quitting||business.isBusy())return;
 e.preventDefault();quitting=true;
 business.flushLogin().finally(()=>app.quit());
});
app.on('window-all-closed',()=>app.quit());
