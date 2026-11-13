const fs = require('node:fs/promises');
const path = require('node:path');

const allowedDomain = domain => /(^|\.)(taobao\.com|tmall\.com)$/.test(String(domain));
const identity = cookie => [cookie.domain, cookie.path, cookie.name].join('\n');

// Chrome stores persistent cookies in the profile. Keep session cookies encrypted
// as well, restoring them before the first navigation without changing expiry.
function createTaobaoLoginState({context, file, encryption, onError = () => {}}) {
  let queue = Promise.resolve();
  let timer;
  let stopped = false;
  function report() {
    onError('淘宝登录记录未能保存或恢复，下次可能需要重新登录。');
  }
  async function restore() {
    try {
      const bytes = await fs.readFile(file);
      if (bytes.length > 2 * 1024 * 1024 || !encryption.isEncryptionAvailable()) throw Error('Invalid encrypted state');
      const state = JSON.parse(encryption.decryptString(bytes));
      if (state.version !== 1 || !Array.isArray(state.cookies)) throw Error('Invalid state');
      const existing = new Set((await context.cookies()).map(identity));
      const cookies = state.cookies.filter(cookie => cookie && cookie.expires === -1 &&
        allowedDomain(cookie.domain) && typeof cookie.name === 'string' &&
        typeof cookie.value === 'string' && !existing.has(identity(cookie)));
      if (cookies.length) await context.addCookies(cookies);
    } catch (error) {
      if (error.code !== 'ENOENT') report();
    }
  }
  function save() {
    queue = queue.then(async () => {
      if (!encryption.isEncryptionAvailable()) throw Error('Encryption unavailable');
      const cookies = (await context.cookies()).filter(cookie => cookie.expires === -1 && allowedDomain(cookie.domain));
      const bytes = encryption.encryptString(JSON.stringify({version: 1, cookies}));
      await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
      await fs.writeFile(file + '.tmp', bytes, {mode: 0o600});
      await fs.rename(file + '.tmp', file);
    }).catch(report);
    return queue;
  }
  function start() {
    if (timer || stopped) return;
    timer = setInterval(save, 5000);
    timer.unref();
  }
  function stop() {
    stopped = true;
    clearInterval(timer);
    timer = undefined;
  }
  async function flush() {
    stop();
    await save();
  }
  return {restore, save, start, stop, flush};
}
module.exports = {createTaobaoLoginState};
