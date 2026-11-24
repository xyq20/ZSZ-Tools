const fs = require('node:fs');
const path = require('node:path');

const UNITS = {
  seconds: {ms:1000,label:'秒'},
  minutes: {ms:60_000,label:'分钟'},
  hours: {ms:3_600_000,label:'小时'},
};
const STATES = ['pending', 'running', 'stopping', 'review', 'cancelled'];
const DUE_TOLERANCE = 5000;

function parseInterval(value, unit) {
  if ((typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) ||
      !Object.hasOwn(UNITS, unit)) throw Error('请输入大于 0 的整数间隔。');
  const count = Number(value);
  const intervalMs = count * UNITS[unit].ms;
  if (!Number.isSafeInteger(intervalMs) || !Number.isSafeInteger(count) || count < 1) {
    throw Error('请输入大于 0 的整数间隔。');
  }
  return {count, unit, intervalMs, label: `${count} ${UNITS[unit].label}`};
}

function createErpStockSchedule({file, execute, notify, now = Date.now}) {
  let plan = null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.version !== 1 || !STATES.includes(saved.state) ||
        !Number.isSafeInteger(saved.nextAt) || !Number.isFinite(new Date(saved.nextAt).getTime()) ||
        (saved.results !== undefined && !Array.isArray(saved.results)) ||
        typeof saved.fingerprint !== 'string' || typeof saved.session !== 'string' ||
        !Array.isArray(saved.rules) || !saved.rules.length ||
        saved.rules.some(rule => !Number.isSafeInteger(rule.number) || rule.number < 1 ||
          typeof rule.name !== 'string' || typeof rule.created_at !== 'string') ||
        new Set(saved.rules.map(rule => rule.number)).size !== saved.rules.length) {
      throw Error('Invalid schedule');
    }
    const interval = parseInterval(saved.count, saved.unit);
    if (interval.intervalMs !== saved.intervalMs) throw Error('Invalid interval');
    plan = ['running','stopping'].includes(saved.state)
      ? {...saved, state: 'review', message: '上次定时执行中断，结果待核实。请先到快麦核对。'}
      : saved;
  } catch (error) {
    if (error.code !== 'ENOENT') plan = {state:'invalid', message:'无法读取本机定时记录，请重新设置。'};
  }

  function status() {
    if (!plan) return null;
    const {state, nextAt, count, unit, rules, message, results} = plan;
    return {state, nextAt, count, unit, rules, message, results};
  }

  function save(next) {
    fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(next), {mode: 0o600, flush:true});
    fs.renameSync(temp, file);
    plan = next;
    const publicState = status();
    notify(publicState);
    return publicState;
  }

  function nextRun(intervalMs, slot = now()) {
    const intervals = Math.max(1, Math.ceil((now() - slot) / intervalMs));
    const nextAt = slot + intervals * intervalMs;
    if (!Number.isFinite(new Date(nextAt).getTime())) throw Error('间隔太长，请缩短后重试。');
    return nextAt;
  }

  async function runDue() {
    const instant = now();
    if (plan?.state !== 'pending' || instant < plan.nextAt) return;
    if (instant >= plan.nextAt + Math.min(DUE_TOLERANCE, plan.intervalMs)) {
      save({...plan, nextAt:nextRun(plan.intervalMs, plan.nextAt), message:'已跳过错过的轮次，按原间隔继续。'});
      return;
    }
    const active = {...plan, state:'running', message:'正在核对快麦会话和规则清单。'};
    save(active);
    let final;
    try {
      const result = await execute({
        action: 'upload', numbers: active.rules.map(rule => rule.number),
        fingerprint: active.fingerprint, session: active.session,
      }, () => plan.state === 'stopping');
      const accepted = result.rows.filter(row => row.status === '快麦已受理').length;
      const complete = result.complete === true && accepted === active.rules.length;
      const stopping = plan.state === 'stopping';
      const shouldContinue = complete && !stopping;
      const finished = complete || (stopping && result.cancelled);
      final = {...active, results: result.rows, state: shouldContinue ? 'pending' : finished ? 'cancelled' : 'review',
        nextAt:shouldContinue ? nextRun(active.intervalMs, active.nextAt) : active.nextAt,
        message: shouldContinue ? `上一轮快麦已受理 ${accepted} 条规则。` :
          `循环已停止。本轮快麦已受理 ${accepted} 条规则。${result.error || ''}`};
    } catch (error) {
      final = {...active, state:'review', message:error.message + ' 如有规则已点击确定，请先到快麦核对。'};
    }
    try {
      save(final);
    } catch {
      plan = {...final, state:'review', message:final.message + ' 结果保存失败，请核对后再安排下一批。'};
      notify(status());
    }
  }

  return {
    status,
    isDue: () => plan?.state === 'pending' && now() >= plan.nextAt,
    schedule(value, unit, rules, fingerprint, session) {
      const interval = parseInterval(value,unit);
      return save({version:1, state:'pending', ...interval, nextAt:nextRun(interval.intervalMs), rules, fingerprint, session});
    },
    updateInterval(value, unit) {
      if (plan?.state !== 'pending') throw Error('当前没有可调整的循环上传。');
      const interval = parseInterval(value,unit);
      if (interval.count === plan.count && unit === plan.unit) return status();
      return save({...plan, ...interval, nextAt:nextRun(interval.intervalMs), message:'间隔已更新，从现在重新计时。'});
    },
    cancel() {
      if (plan?.state === 'running') {
        return save({...plan, state:'stopping', message:'当前轮结束后停止循环。'});
      }
      if (plan?.state !== 'pending') throw Error('当前没有等待执行的循环上传。');
      return save({...plan, state:'cancelled', message:undefined});
    },
    runDue,
  };
}

module.exports = {createErpStockSchedule, parseInterval};
