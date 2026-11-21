import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export async function lockRuntime(runtime) {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const path = join(runtime, 'run.lock');
  let file;
  try {
    file = await open(path, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('已有任务使用独立会话，或上次进程异常退出。请先确认没有任务在运行，再移除 .runtime/run.lock。');
    throw error;
  }
  try {
    await file.writeFile(`${process.pid}\n`);
  } finally {
    await file.close();
  }
  return () => rm(path, { force: true });
}

export async function readState(runtime) {
  try {
    const state = JSON.parse(await readFile(join(runtime, 'publish-state.json'), 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state) ||
        Object.values(state).some(entry => !['pending', 'published'].includes(entry?.status))) {
      throw new Error('发布状态文件结构异常');
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function saveState(runtime, state) {
  const file = join(runtime, 'publish-state.json');
  const temporary = `${file}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}
