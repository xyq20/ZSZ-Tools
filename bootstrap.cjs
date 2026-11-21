const {app} = require('electron');
app.setPath('userData', require('node:path').join(app.getPath('appData'), 'team-toolkit'));
if (process.platform === 'win32' && app.isPackaged) {
  require('./business/windows-versions.cjs').redirect(app.getPath('exe'), app.getVersion(), process.argv.slice(1))
    .then(forwarded => forwarded ? app.exit(0) : require('./main.cjs'), () => require('./main.cjs'));
} else {
  require('./main.cjs');
}
