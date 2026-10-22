const fs = require('node:fs/promises');
const path = require('node:path');

const allowedDomain = domain => /(^|\.)(superboss\.cc|kuaimai\.com)$/.test(String(domain).replace(/^\./, ''));
const identity = c => [c.domain, c.path, c.name].join('\n');

// Chromium persists long-lived cookies itself. Session cookies need a separate,
// encrypted snapshot to survive a normal application restart.
function createLoginState({ directory, sessions, encryption, onError = () => {} }) {
  const queues = new Map(), timers = new Map(), listeners = new Map();
  let restoring = true;
  const location = tool => path.join(directory, tool + '.bin');
  const reportError = () => onError('本机登录记录未能保存或恢复，可能需要重新登录。');

  function save(tool) {
    const job = (queues.get(tool) || Promise.resolve()).then(async () => {
      if (!encryption.isEncryptionAvailable()) throw Error('Encryption unavailable');
      const cookies = (await sessions[tool].cookies.get({})).filter(c => c.session && allowedDomain(c.domain));
      const bytes = encryption.encryptString(JSON.stringify({ version: 1, cookies }));
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = location(tool) + '.tmp';
      await fs.writeFile(temporary, bytes, { mode: 0o600 });
      await fs.rename(temporary, location(tool));
    }).catch(reportError);
    queues.set(tool, job);
    return job;
  }

  async function restore() {
    for (const [tool, partition] of Object.entries(sessions)) {
      try {
        const bytes = await fs.readFile(location(tool));
        if (bytes.length > 2 * 1024 * 1024 || !encryption.isEncryptionAvailable()) throw Error('Invalid encrypted state');
        const state = JSON.parse(encryption.decryptString(bytes));
        if (state.version !== 1 || !Array.isArray(state.cookies)) throw Error('Invalid state');
        const current = new Set((await partition.cookies.get({})).map(identity));
        for (const c of state.cookies) {
          if (!c.session || !allowedDomain(c.domain) || typeof c.name !== 'string' || typeof c.value !== 'string' || current.has(identity(c))) continue;
          const cookie = { url: 'https://' + c.domain.replace(/^\./, '') + (c.path || '/'), name: c.name, value: c.value,
            path: c.path || '/', secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite };
          if (!c.hostOnly) cookie.domain = c.domain;
          await partition.cookies.set(cookie);
        }
      } catch (e) {
        if (e.code !== 'ENOENT') reportError();
      }
    }
    restoring = false;
    for (const [tool, partition] of Object.entries(sessions)) {
      const listener = () => {
        if (restoring) return;
        clearTimeout(timers.get(tool));
        timers.set(tool, setTimeout(() => { timers.delete(tool); save(tool); }, 400));
      };
      listeners.set(tool, listener);
      partition.cookies.on('changed', listener);
    }
  }

  async function flush() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const tool of Object.keys(sessions)) {
      await save(tool);
      await sessions[tool].cookies.flushStore().catch(reportError);
    }
  }

  return { restore, flush };
}

module.exports = { createLoginState };
