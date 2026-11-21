const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const packReminderDefaults = require('./pack-taobao-reminder-defaults.cjs');

module.exports = async context => {
  await packReminderDefaults(context);
  if (context.electronPlatformName !== 'darwin') return;
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const source = path.join(context.packager.projectDir, 'modules', 'taobao-soutu', 'recognize.m');
  const executable = path.join(resources, 'soutu-ocr');
  await promisify(execFile)('clang', ['-fobjc-arc', '-framework', 'Foundation', '-framework', 'Vision', source, '-o', executable]);
};
