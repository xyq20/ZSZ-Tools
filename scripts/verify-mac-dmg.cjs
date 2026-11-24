const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

module.exports = async ({file}) => {
  if (!file?.endsWith('.dmg')) return;
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-dmg-'));
  let attached = false;
  try {
    execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, file]);
    attached = true;
    const app = path.join(mount, '钊叔工具箱.app');
    execFileSync('codesign', ['--verify', '--deep', '--strict', app]);
  } finally {
    if (attached) execFileSync('hdiutil', ['detach', mount]);
    fs.rmdirSync(mount);
  }
};
