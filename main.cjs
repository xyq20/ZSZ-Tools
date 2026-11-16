const {app,BrowserWindow,ipcMain,dialog,shell,Menu}=require('electron');
const path=require('node:path');
app.commandLine.appendSwitch('lang','zh-CN');
app.commandLine.appendSwitch('accept-lang','zh-CN');
const {createUpdater,acknowledgeUpdate}=require('./business/app-update.cjs');
const updateConfig=require('./update-config.json');
let win,updater;
let business,quitting=false;
const {restoreWindow}=require('./business/windows.cjs');
app.on('activate',()=>restoreWindow(win));
app.setPath('userData',path.join(app.getPath('appData'),'team-toolkit'));
const ownsLock=app.requestSingleInstanceLock();
if(!ownsLock){app.quit();}else{
app.on('second-instance',()=>restoreWindow(win));
}
ipcMain.handle('app-version',()=>app.getVersion());
for(const [channel,method] of [['check-update','check'],['download-update','download'],['install-update','install'],['cancel-update','cancel'],['update-state','state']]){
 ipcMain.handle(channel,(event)=>{if(!win||event.sender!==win.webContents||!updater)throw Error('非法更新请求');return updater[method]();});
}
app.whenReady().then(()=>{
if(!ownsLock)return;
if(process.platform==='darwin')Menu.setApplicationMenu(Menu.buildFromTemplate([
 {label:'钊叔工具箱',submenu:[{label:'关于钊叔工具箱',role:'about'},{type:'separator'},{label:'隐藏钊叔工具箱',role:'hide'},{label:'隐藏其他应用',role:'hideOthers'},{label:'显示全部',role:'unhide'},{type:'separator'},{label:'退出钊叔工具箱',role:'quit'}]},
 {label:'编辑',submenu:[{label:'撤销',role:'undo'},{label:'重做',role:'redo'},{type:'separator'},{label:'剪切',role:'cut'},{label:'复制',role:'copy'},{label:'粘贴',role:'paste'},{label:'全选',role:'selectAll'}]},
 {label:'窗口',submenu:[{label:'最小化',role:'minimize'},{label:'缩放',role:'zoom'},{label:'关闭窗口',role:'close'}]}
]));
win=new BrowserWindow({width:1280,height:850,minWidth:1000,minHeight:680,backgroundColor:'#f5f6f8',title:'钊叔工具箱',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
business=require('./business/desktop.cjs').setupBusiness(win,app);
updater=createUpdater({app,manifestUrl:updateConfig.manifestUrl,business,
 notify:data=>{if(!win.isDestroyed())win.webContents.send('update-progress',data);},
 confirm:async()=>{const r=await dialog.showMessageBox(win,{type:'question',buttons:['稍后','重启并安装'],defaultId:0,cancelId:0,message:'重启并安装新版工具箱？',detail:'登录和配置会保留。尚未保存的预览结果需要重新查询；尚未发布的淘宝批次请先处理完毕。'});return r.response===1;}
});
win.on('close',e=>{if(updater.isInstalling()&&!updater.canQuit())e.preventDefault();});
win.webContents.once('did-finish-load',()=>acknowledgeUpdate(app));
win.removeMenu();win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());win.loadFile(path.join(__dirname,'app/index.html'));
ipcMain.handle('choose-workbook',async()=>{const r=await dialog.showOpenDialog(win,{title:'选择 Excel 工作簿',buttonLabel:'打开',properties:['openFile'],filters:[{name:'Excel 工作簿',extensions:['xlsx']}]});return r.canceled?null:{name:path.basename(r.filePaths[0])};});
});
app.on('before-quit',e=>{
 if(updater?.isInstalling()){if(!updater.canQuit())e.preventDefault();return;}
 if(business?.isBusy()){e.preventDefault();return;}
 if(!business||quitting)return;
 e.preventDefault();quitting=true;
 business.flushLogin().finally(()=>app.quit());
});
app.on('window-all-closed',()=>app.quit());
