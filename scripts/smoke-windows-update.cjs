// Release smoke test for a disposable Windows runner. Exercise the exact helper
// shipped by the starting version after its download has been verified.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {setTimeout: delay} = require('node:timers/promises');
const asar = require('@electron/asar');
const {chromium} = require('playwright-core');
const {verifyFile} = require('../business/windows-update.cjs');
const {validUninstaller} = require('../build/verify-nsis-uninstaller.cjs');

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

async function installBaseline(baseFile, version) {
  await assert.rejects(fs.access(path.dirname(updates)), {code: 'ENOENT'});
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-upgrade-'));
  const installDir = path.join(root, '工具箱');
  const options = {cwd: root, stdio: 'ignore'};
  assert.equal(await finished(spawn(baseFile, ['/S', '/currentuser', '/D=' + installDir], options)), 0);
  const executable = path.join(installDir, '钊叔工具箱.exe');
  const archive = path.join(installDir, 'resources', 'app.asar');
  assert.equal(versionOf(archive), version);
  console.log('Installed baseline', version);
  return {installDir, executable, archive, options};
}

// Post-publication check. Drive the renderer buttons and let the unchanged
// installed application discover, download, verify and apply the public release.
async function verifyPublishedUpdate(release, baseFile) {
  const from = release.tag_name.slice(1);
  const version = require('../package.json').version;
  const asset = release.assets.find(item => item.name === '-' + from + '-win-x64.exe');
  await verifyFile(baseFile, {size:asset.size, sha256:asset.digest.slice(7)});
  const {installDir, executable, archive} = await installBaseline(baseFile, from);
  const socket = net.createServer();
  await new Promise((resolve,reject) => socket.once('error',reject).listen(0,'127.0.0.1',resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const endpoint = 'http://127.0.0.1:' + port;
  const old = spawn(executable, ['--remote-debugging-address=127.0.0.1','--remote-debugging-port=' + port],
    {cwd:installDir, stdio:'ignore'});
  const directory = path.join(updates,version+'-win32-x64');
  let browser, page;
  try {
    await waitFor('installed app UI',() => fetch(endpoint+'/json/version').then(r=>r.ok,()=>false));
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    page = context.pages()[0] || await context.waitForEvent('page');
    await page.locator('#check-update').click();
    await page.locator('#download-update').waitFor({timeout:90000});
    assert((await page.locator('#update-status').innerText()).includes('v'+version), 'unexpected online update offer');
    await page.locator('#download-update').click();
    await page.locator('#install-update').waitFor({timeout:360000});
    assert.equal(await page.locator('#update-percent').innerText(),'100%');
    console.log('Public offer found and downloaded through the installed UI:',version);
    await page.locator('#install-update').click({noWaitAfter:true});
    await waitFor('public update to relaunch', async () => {
      const failure = await fs.readFile(path.join(directory,'healthy.failed'),'utf8').catch(()=>null);
      if(failure)throw Error(failure);
      return fs.access(path.join(directory,'healthy')).then(()=>true,()=>false);
    },360000);
    assert.equal(versionOf(archive),version);
    await waitFor('helper to confirm the public upgrade',async () =>
      (await fs.readFile(path.join(directory,'install.log'),'utf8').catch(()=>'')).includes('新版工具箱已启动'));
    console.log('Public Windows UI upgrade verified:',from,'->',version);
  } catch(error) {
    if(page && !page.isClosed())console.error(await page.locator('#update-status').innerText().catch(()=>''));
    throw error;
  } finally {
    if(browser)await browser.close().catch(()=>{});
    if(old.exitCode===null && old.signalCode===null)old.kill();
  }
}

async function verifyUpgrade(metadata, baseFile, targetFile) {
  const version = require('../package.json').version;
  const candidate = metadata.assets.find(asset => asset.name.endsWith('-' + version + '-win-x64.exe'));
  const baseline = metadata.assets.find(asset => /^test-from-([\d.]+)-win-x64\.exe$/.test(asset.name));
  const fromVersion = baseline.name.match(/^test-from-([\d.]+)/)[1];
  const info = asset => ({size: asset.size, sha256: asset.digest.replace(/^sha256:/, '')});
  await Promise.all([verifyFile(baseFile, info(baseline)), verifyFile(targetFile, info(candidate))]);
  const {installDir, executable, archive, options} = await installBaseline(baseFile, fromVersion);
  const uninstaller = path.join(installDir,'Uninstall 钊叔工具箱.exe');
  const neededRepair = !validUninstaller(await fs.readFile(uninstaller));
  console.log('Starting uninstaller CRC repair required:',neededRepair);
  const defaultsFile = path.join(installDir, 'resources', 'taobao-reminders-defaults.json');
  const directory = path.join(updates, version + '-win32-x64');
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
    // Stand-in for settings present in an older internal installation.
    const oldDefaults = '{"fixture":"preserve-on-update"}';
    await fs.writeFile(defaultsFile, oldDefaults);
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
      assert.equal(JSON.parse(diagnostic.stdout.trim()).selected,true,'registered process path was not recognized');
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
    const localSetting = path.join(path.dirname(updates),'upgrade-smoke-setting');
    await fs.writeFile(localSetting,'preserve');
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
    assert(validUninstaller(await fs.readFile(uninstaller)),'installed uninstaller CRC is invalid');
    assert.equal(await fs.readFile(localSetting,'utf8'),'preserve');
    assert.equal(await fs.readFile(defaultsFile, 'utf8'), oldDefaults);
    assert.equal(await fs.readFile(path.join(directory, 'healthy'), 'utf8'), 'ok');
    assert.match(await fs.readFile(path.join(directory, 'install.log'), 'utf8'), /新版工具箱已启动/);
    const cleanupTrace = await fs.readFile(cleanupLog, 'utf8');
    assert(cleanupTrace.includes('PID=' + locked.pid), 'residual process was not exercised');
    if(neededRepair)assert(cleanupTrace.includes('已修复旧版卸载器校验错误'),'legacy uninstaller was not repaired');
    assert.notEqual(locked.exitCode, null);
    assert.equal(marker.exitCode, null);
    await assert.rejects(fs.access(path.join(directory, 'helper-' + token + '.ready')), {code: 'ENOENT'});
    await assert.rejects(fs.access(path.join(updates, 'pending.json')), {code: 'ENOENT'});
    console.log('Confirmed real installer, relaunch and health acknowledgement:', fromVersion, '->', version);
    if (cleanupFailure) throw cleanupFailure;
  } catch (error) {
    console.error('Installed version after failure',versionOf(archive));
    console.error('Pending',await fs.readFile(path.join(updates,'pending.json'),'utf8').catch(()=>'absent'));
    console.error('Application windows',(await ps("Get-Process | Where-Object ProcessName -eq '钊叔工具箱' | Select-Object Id,MainWindowTitle,Path | ConvertTo-Json -Compress")).stdout);
    console.error('Window diagnostics',(await ps(`
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      foreach ($p in @(Get-Process -Name '钊叔工具箱' -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0)) {
        $window = [Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
        $window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition) |
          Select-Object -First 30 | ForEach-Object { $_.Current.Name }
      }
    `).catch(()=>({stdout:''}))).stdout.slice(0,2800));
    for (const log of [cleanupLog, path.join(path.dirname(updates),'startup.log'), path.join(directory, 'install.log'), path.join(directory, 'healthy.failed')]) {
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
  assert(process.platform === 'win32' && process.env.RUNNER_ENVIRONMENT === 'github-hosted',
    'Use a disposable GitHub-hosted Windows runner.');
  const [manifest, baseline, candidate] = process.argv.slice(2);
  const metadata = JSON.parse((await fs.readFile(manifest, 'utf8')).replace(/^\uFEFF/, ''));
  if(candidate)await verifyUpgrade(metadata, baseline, candidate);
  else await verifyPublishedUpdate(metadata,baseline);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
