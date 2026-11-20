const fs = require('node:fs/promises');
const path = require('node:path');
const {feishuDefaults, DEFAULTS_FILE} = require('../business/taobao-reminders.cjs');

module.exports = async ({packager, appOutDir}) => {
  const state = process.env.TOOLKIT_INTERNAL_TAOBAO_STATE_DIR;
  if (!state) return;

  const [webhook, recipient] = await Promise.all([
    fs.readFile(path.join(state, 'webhook'), 'utf8'),
    fs.readFile(path.join(state, 'recipient-id'), 'utf8'),
  ]);
  const defaults = feishuDefaults({webhook, recipient});
  const resources = packager.getResourcesDir(appOutDir);
  await fs.writeFile(path.join(resources, DEFAULTS_FILE), JSON.stringify(defaults), {mode: 0o600});
};
