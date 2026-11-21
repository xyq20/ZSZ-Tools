import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function recognizeImages(images, { executable } = {}) {
  if (!images.length) return [];
  const folder = await mkdtemp(join(tmpdir(), 'soutu-ocr-'));
  try {
    const paths = images.map((_, index) => join(folder, `row-${index}.png`));
    await Promise.all(paths.map((path, index) => writeFile(path, images[index], { mode: 0o600 })));
    const options = { timeout: 45_000, maxBuffer: 512 * 1024, windowsHide: true };
    if (process.platform === 'darwin') {
      const binary = executable || join(folder, 'recognize');
      if (!executable) {
        const source = fileURLToPath(new URL('./recognize.m', import.meta.url));
        await execute('clang', ['-fobjc-arc', '-framework', 'Foundation', '-framework', 'Vision', source, '-o', binary], options);
      }
      const { stdout } = await execute(binary, paths, options);
      return JSON.parse(stdout);
    }

    if (process.platform === 'win32') {
      const script = await readFile(new URL('./recognize.ps1', import.meta.url), 'utf8');
      const escaped = folder.replaceAll("'", "''");
      const command = `& { ${script} } -ImageDirectory '${escaped}'`;
      const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')];
      const { stdout } = await execute(powershell, args, options);
      return JSON.parse(stdout);
    }

    const results = [];
    for (const path of paths) {
      const { stdout } = await execute('tesseract', [path, 'stdout', '-l', 'chi_sim+eng', '--psm', '11'], options);
      results.push(stdout.trim());
    }
    return results;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
