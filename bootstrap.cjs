const {app} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const data = path.join(app.getPath('appData'),'team-toolkit');
fs.mkdirSync(data,{recursive:true,mode:0o700});
app.setPath('userData',data);

let active;
if(process.platform==='win32' && app.isPackaged){
  active=require('./business/windows-versions.cjs').launchTarget(app.getPath('exe'),app.getVersion());
}
if(active){
  const child=require('node:child_process').spawn(active,process.argv.slice(1),
    {cwd:path.dirname(active),detached:true,stdio:'ignore'});
  child.once('spawn',()=>{child.unref();app.exit(0);});
  child.once('error',()=>require('./main.cjs'));
}else{
  require('./main.cjs');
}
