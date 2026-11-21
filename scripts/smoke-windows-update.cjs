// Release smoke test for a disposable Windows runner. Exercise the exact helper
// shipped by the starting version after its download has been verified.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {setTimeout: delay} = require('node:timers/promises');
const asar = require('@electron/asar');
const {verifyFile} = require('../business/windows-update.cjs');

const exec = promisify(execFile);
const updates = path.join(process.env.APPDATA || '', 'team-toolkit', 'updates');
const cleanupLog = path.join(os.tmpdir(), 'toolkit-install-processes.log');
const ps = command => exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
function versionOf(archive) {
  asar.uncache(archive);
  return JSON.parse(asar.extractFile(archive, 'package.json')).version;
}

async function waitFor(description, check, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(250);
  }
  throw Error('Timed out waiting for ' + description);
}

function finished(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => signal ? reject(Error(signal)) : resolve(code));
  });
}

async function windowReady(child) {
  await waitFor('visible window for PID ' + child.pid, async () => {
    assert.equal(child.exitCode, null, 'process exited before showing a window');
    const {stdout} = await ps('(Get-Process -Id ' + child.pid + ').MainWindowHandle.ToInt64()');
    return Number(stdout.trim()) !== 0;
  });
}

async function verifyUpgrade(metadata, baseFile, targetFile) {
  assert(process.platform === 'win32' && process.env.RUNNER_ENVIRONMENT === 'github-hosted',
    'Use a disposable GitHub-hosted Windows runner.');
  const version = require('../package.json').version;
  const candidate = metadata.assets.find(asset => asset.name.endsWith('-' + version + '-win-x64.exe'));
  const baseline = metadata.assets.find(asset => /^test-from-([\d.]+)-win-x64\.exe$/.test(asset.name));
  const fromVersion = baseline.name.match(/^test-from-([\d.]+)/)[1];
  const info = asset => ({size: asset.size, sha256: asset.digest.replace(/^sha256:/, '')});
  await Promise.all([verifyFile(baseFile, info(baseline)), verifyFile(targetFile, info(candidate))]);
  await assert.rejects(fs.access(path.dirname(updates)), {code: 'ENOENT'});
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-upgrade-'));
  const installDir = path.join(root, '工具箱');
  const executable = path.join(installDir, '钊叔工具箱.exe');
  const archive = path.join(installDir, 'resources', 'app.asar');
  const defaultsFile = path.join(installDir, 'resources', 'taobao-reminders-defaults.json');
  const directory = path.join(updates, version + '-win32-x64');
  const options = {cwd: root, stdio: 'ignore'};
  async function holdExecutable() {
    const child = spawn(executable, ['-e', 'process.stdout.write("ready");setInterval(() => {},1000)'], {
      ...options, stdio: ['ignore','pipe','inherit'], env: {...process.env, ELECTRON_RUN_AS_NODE: '1'},
    });
    await new Promise((resolve,reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error('Fixture did not acquire the executable')); },15000);
      child.stdout.once('data',() => { clearTimeout(timer); resolve(); });
      child.once('exit',() => { clearTimeout(timer); reject(Error('Fixture exited before handoff')); });
      child.once('error',error => { clearTimeout(timer); reject(error); });
    });
    return child;
  }

  let marker, installerWindow, locked, old, cleanupFailure;
  try {
    assert.equal(await finished(spawn(baseFile, ['/S', '/currentuser', '/D=' + installDir], options)), 0);
    assert.equal(versionOf(archive), fromVersion);
    // Stand-in for settings present in an older internal installation.
    const oldDefaults = '{"fixture":"preserve-on-update"}';
    await fs.writeFile(defaultsFile, oldDefaults);
    console.log('Installed baseline', fromVersion);
    marker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);

    // Windows-hosted runners have an administrative token. Invoke the same
    // cleanup-only entry that Windows runs after an interactive UAC approval.
    installerWindow = spawn(targetFile, [], options);
    await windowReady(installerWindow);
    locked = await holdExecutable();
    try {
      const negative = await finished(spawn(targetFile, ['/S', '/toolkit-cleanup=0'], options));
      console.log('Invalid cleanup caller returned', negative);
      assert.equal(negative, 5, 'cleanup-only mode must reject an invalid caller');
      const diagnostic = await ps(`
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        . ./build/stop-toolkit-processes.ps1 -LibraryOnly
        $location = @(Get-ChildItem HKCU:\\Software | ForEach-Object { $_.GetValue('InstallLocation') } | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'resources\\app.asar')) })
        $image = Get-CimInstance Win32_Process -Filter "ProcessId = ${locked.pid}"
        $roots = @(Get-ToolkitRoots $location)
        [pscustomobject]@{registered=$location; roots=$roots; processPath=$image.ExecutablePath; session=$image.SessionId; selected=(Test-ToolkitPath $image $roots $true)} | ConvertTo-Json -Compress
      `);
      console.log('Windows process identity', diagnostic.stdout.trim());
      assert.equal(await finished(spawn(targetFile, ['/S', '/toolkit-cleanup=' + installerWindow.pid], options)), 0,
        'registered-process cleanup failed');
      await waitFor('registered process to exit', () => locked.exitCode !== null, 3000);
      console.log('Privileged cleanup closed the registered executable.');
    } catch (error) {
      cleanupFailure = error;
      console.error('Cleanup-only check:',error.message);
      if (locked.exitCode === null) locked.kill();
    }
    assert.equal(marker.exitCode, null);
    assert.equal(versionOf(archive), fromVersion, 'cleanup-only mode changed the installation');
    const closed = new Promise(resolve => installerWindow.once('exit', resolve));
    installerWindow.kill();
    await closed;
    installerWindow = null;

    old = spawn(executable, [], {...options, cwd:installDir});
    await windowReady(old);
    locked = await holdExecutable();
    await fs.mkdir(directory, {recursive: true});
    const file = path.join(directory, 'installer.exe');
    const runtime = path.join(directory, 'update-node.exe');
    const helper = path.join(directory, 'windows-update.cjs');
    await fs.copyFile(targetFile, file);
    await fs.copyFile(path.join(installDir, 'resources/python/Lib/site-packages/playwright/driver/node.exe'), runtime);
    await fs.writeFile(helper, asar.extractFile(archive, 'business/windows-update.cjs'));
    const token = crypto.randomBytes(16).toString('hex');
    const request = {parentPid: old.pid, file, info: info(candidate), executable, directory, token};
    await fs.writeFile(path.join(updates, 'pending.json'), JSON.stringify({version, directory, token}));
    const apply = spawn(runtime, [helper, JSON.stringify(request)], {cwd: installDir, stdio: 'inherit'});
    const applied = finished(apply);
    await waitFor('baseline helper to be ready', () =>
      fs.access(path.join(directory, 'helper-' + token + '.ready')).then(() => true, () => false));
    const {stdout} = await ps('(Get-Process -Id ' + old.pid + ').CloseMainWindow()');
    assert.equal(stdout.trim(), 'True');
    assert.equal(await applied, 0, 'baseline helper failed to update');
    assert.equal(versionOf(archive), version);
    assert.equal(await fs.readFile(defaultsFile, 'utf8'), oldDefaults);
    assert.equal(await fs.readFile(path.join(directory, 'healthy'), 'utf8'), 'ok');
    assert.match(await fs.readFile(path.join(directory, 'install.log'), 'utf8'), /新版工具箱已启动/);
    assert((await fs.readFile(cleanupLog, 'utf8')).includes('PID=' + locked.pid), 'residual process was not exercised');
    assert.notEqual(locked.exitCode, null);
    assert.equal(marker.exitCode, null);
    await assert.rejects(fs.access(path.join(directory, 'helper-' + token + '.ready')), {code: 'ENOENT'});
    await assert.rejects(fs.access(path.join(updates, 'pending.json')), {code: 'ENOENT'});
    console.log('Confirmed real installer, relaunch and health acknowledgement:', fromVersion, '->', version);
    if (cleanupFailure) throw cleanupFailure;
  } catch (error) {
    for (const log of [cleanupLog, path.join(directory, 'install.log'), path.join(directory, 'healthy.failed')]) {
      const detail = await fs.readFile(log, 'utf8').catch(() => '');
      if (detail) console.error(path.basename(log), detail.slice(-2400));
    }
    throw error;
  } finally {
    for (const child of [marker, installerWindow, locked, old]) {
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
    }
  }
}

(async () => {
  const [manifest, baseline, candidate] = process.argv.slice(2);
  const metadata = JSON.parse((await fs.readFile(manifest, 'utf8')).replace(/^\uFEFF/, ''));
  await verifyUpgrade(metadata, baseline, candidate);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
