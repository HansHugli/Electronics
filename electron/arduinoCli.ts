import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import https from 'https';
import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import { createWriteStream } from 'fs';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const ARDUINO_CLI_VERSION = '1.1.1';

function getToolsDir(): string {
  return path.join(app.getPath('userData'), 'tools');
}

function getCliBinary(): string {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(getToolsDir(), `arduino-cli${ext}`);
}

function getDownloadUrl(): string {
  const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  const arch = process.arch === 'arm64' ? 'ARM64' : '64bit';
  const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
  return `https://downloads.arduino.cc/arduino-cli/arduino-cli_${ARDUINO_CLI_VERSION}_${platform}_${arch}.${ext}`;
}

export function isCliInstalled(): boolean {
  return fs.existsSync(getCliBinary());
}

export function isCoreInstalled(): boolean {
  const configDir = path.join(getToolsDir(), 'data');
  // arduino-cli may store packages directly or under Arduino15
  const paths = [
    path.join(configDir, 'packages', 'arduino', 'hardware', 'avr'),
    path.join(configDir, 'Arduino15', 'packages', 'arduino', 'hardware', 'avr'),
  ];
  return paths.some((p) => fs.existsSync(p));
}

/** Download a file, following redirects. */
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (u: string, depth = 0) => {
      if (depth > 5) { reject(new Error('Too many redirects')); return; }
      https.get(u, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          follow(res.headers.location!, depth + 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        const file = createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

/** Extract archive using platform tools (PowerShell on Windows, tar on Unix). */
async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  if (process.platform === 'win32') {
    // PowerShell Expand-Archive
    await execAsync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`,
      { timeout: 60000 }
    );
  } else {
    await execAsync(`tar -xzf "${archivePath}" -C "${destDir}"`, { timeout: 60000 });
  }
}

/**
 * Download and install arduino-cli binary.
 */
export async function downloadCli(): Promise<string> {
  const toolsDir = getToolsDir();
  if (!fs.existsSync(toolsDir)) fs.mkdirSync(toolsDir, { recursive: true });

  const url = getDownloadUrl();
  const isZip = url.endsWith('.zip');
  const archivePath = path.join(toolsDir, isZip ? 'arduino-cli.zip' : 'arduino-cli.tar.gz');

  await downloadFile(url, archivePath);
  await extractArchive(archivePath, toolsDir);

  // Clean up archive
  try { fs.unlinkSync(archivePath); } catch { /* ignore */ }

  // Make executable on unix
  const bin = getCliBinary();
  if (process.platform !== 'win32') {
    fs.chmodSync(bin, 0o755);
  }

  return 'arduino-cli installed';
}

/**
 * Install the Arduino AVR core.
 */
export async function installCore(): Promise<string> {
  const cli = getCliBinary();
  const dataDir = path.join(getToolsDir(), 'data');

  const { stdout, stderr } = await execFileAsync(cli, [
    'core', 'install', 'arduino:avr',
    '--config-dir', dataDir,
  ], { timeout: 300000 }); // 5 min timeout

  return stdout + stderr;
}

/**
 * Compile an Arduino sketch and return the .hex file contents.
 */
export async function compileSketch(sketchCode: string): Promise<{ hex: string; output: string }> {
  const cli = getCliBinary();
  const dataDir = path.join(getToolsDir(), 'data');
  const tmpDir = path.join(app.getPath('temp'), `e101-sketch-${Date.now()}`);
  const sketchDir = path.join(tmpDir, 'sketch');
  const outputDir = path.join(tmpDir, 'output');

  fs.mkdirSync(sketchDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  // Write sketch file
  fs.writeFileSync(path.join(sketchDir, 'sketch.ino'), sketchCode, 'utf-8');

  try {
    const { stdout, stderr } = await execFileAsync(cli, [
      'compile',
      '--fqbn', 'arduino:avr:uno',
      '--output-dir', outputDir,
      '--config-dir', dataDir,
      sketchDir,
    ], { timeout: 60000 });

    // Find the .hex file
    const hexFile = fs.readdirSync(outputDir).find((f) => f.endsWith('.hex'));
    if (!hexFile) {
      throw new Error(`Compilation failed:\n${stdout}\n${stderr}`);
    }

    const hex = fs.readFileSync(path.join(outputDir, hexFile), 'utf-8');
    return { hex, output: stdout + stderr };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error(e.stderr || e.stdout || e.message || 'Compilation failed');
  } finally {
    // Clean up temp dir
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Get status of arduino-cli setup.
 */
export function getSetupStatus(): { cliInstalled: boolean; coreInstalled: boolean } {
  return {
    cliInstalled: isCliInstalled(),
    coreInstalled: isCoreInstalled(),
  };
}
