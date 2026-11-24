const fs = require('node:fs');
const path = require('node:path');
const {createRedactor} = require('./diagnostics.cjs');

function createUpdateLog(root, home) {
  const file = path.join(root, 'update-events.log');
  const redact = createRedactor({home});
  let previous = 'idle';
  let started = Date.now();
  let source = '手动';
  return (state, origin) => {
    if (state.status === previous) return;
    const now = Date.now();
    if (state.status === 'checking') source = origin || '手动';
    const line = [new Date(now).toISOString(), previous === 'checking' || state.status === 'checking' ? source : '更新', state.latest ? state.current+' → '+state.latest : state.current,
      previous + ' → ' + state.status, (['checking','downloading','preparing','installing'].includes(previous) ? '处理耗时 ' : '等待间隔 ') + (now - started) + ' ms',
      state.network === 'system-proxy' ? '系统代理' : state.network === 'direct' ? '直连' : '', redact(state.message || '', 300)].filter(Boolean).join(' · ') + '\n';
    previous = state.status;
    started = now;
    try {
      fs.mkdirSync(root, {recursive:true});
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (size > 65536) fs.renameSync(file, file + '.previous');
      fs.appendFileSync(file, line, {mode:0o600});
    } catch { /* Diagnostics must not interrupt an update. */ }
  };
}
module.exports = {createUpdateLog};
