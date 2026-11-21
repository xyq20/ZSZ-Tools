const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const builder = require.resolve('electron-builder/out/cli/cli.js');
const electronVersion = require('electron/package.json').version;
const args = ['--win', 'nsis', 'zip', '--x64'];
const flags = process.argv.slice(2);

function run(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${path.basename(program)} exited with ${result.status ?? result.signal}`);
}

let stage;
try {
  if (process.platform === 'win32' && process.arch === 'x64') {
    run(process.execPath, [builder, ...args, ...flags], root);
  } else {
    stage = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-win-x64-'));
    for (const entry of ['app', 'build', 'business', 'modules', 'scripts', 'bootstrap.cjs', 'main.cjs',
      'preload.cjs', 'package.json', 'package-lock.json', 'updater.cjs', 'update-config.json']) {
      fs.cpSync(path.join(root, entry), path.join(stage, entry), { recursive: true });
    }
    const manifestPath = path.join(stage, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const updateConfig = JSON.parse(fs.readFileSync(path.join(stage, 'update-config.json'), 'utf8'));
    const updateUrl = new URL(updateConfig.manifestUrl);
    const repository = updateUrl.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/releases\/latest$/);
    if (!manifest.build.publish && updateUrl.hostname === 'api.github.com' && repository) {
      manifest.build.publish = { provider: 'github', owner: repository[1], repo: repository[2] };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    }
    fs.mkdirSync(path.join(stage, 'runtimes'));
    fs.cpSync(path.join(root, 'runtimes', 'win-x64'), path.join(stage, 'runtimes', 'win-x64'), { recursive: true });
    const npm = process.env.npm_execpath;
    if (!npm) throw Error('请通过 npm run dist:win 启动构建');
    run(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--os=win32', '--cpu=x64'], stage);
    if (!fs.existsSync(path.join(stage, 'node_modules', '@img', 'sharp-win32-x64'))) {
      throw Error('Windows x64 的图像处理依赖未安装');
    }
    const output = flags.some(flag => /^--config\.directories\.output(?:=|$)/.test(flag))
      ? [] : [`--config.directories.output=${path.join(root, 'dist')}`];
    run(process.execPath, [builder, ...args, '--projectDir', stage, '--config.npmRebuild=false',
      `--config.electronVersion=${electronVersion}`, ...output, ...flags], stage);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (stage) fs.rmSync(stage, { recursive: true, force: true });
}
