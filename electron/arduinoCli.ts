import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  ARDUINO_CLI_VERSION,
  archiveNameFor,
  downloadVerified,
  expectedSha256,
  tarCommand,
} from './arduinoDownload';

const execFileAsync = promisify(execFile);

function getToolsDir(): string {
  return path.join(app.getPath('userData'), 'tools');
}

function getCliBinary(): string {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(getToolsDir(), `arduino-cli${ext}`);
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

/**
 * Download arduino-cli (pinned version), check its SHA-256 against the
 * published checksum, extract it with tar (argument array, no shell) into a
 * fresh temp folder and copy the program into place. Fails closed when no
 * verified checksum exists for this platform.
 */
export async function downloadCli(): Promise<string> {
  const toolsDir = getToolsDir();
  fs.mkdirSync(toolsDir, { recursive: true });

  const archive = archiveNameFor(process.platform, process.arch);
  const sha = archive ? expectedSha256(archive) : null;
  if (!archive || !sha) {
    throw new Error(
      `There is no verified arduino-cli ${ARDUINO_CLI_VERSION} download for this system (${process.platform} ${process.arch}). ` +
        `Install arduino-cli yourself and copy it to ${toolsDir}.`,
    );
  }

  const work = fs.mkdtempSync(path.join(app.getPath('temp'), 'e101-cli-'));
  try {
    const archivePath = path.join(work, archive);
    await downloadVerified(`https://downloads.arduino.cc/arduino-cli/${archive}`, archivePath, sha);
    const outDir = path.join(work, 'out');
    fs.mkdirSync(outDir);
    await execFileAsync(tarCommand(process.platform), ['-xf', archivePath, '-C', outDir], { timeout: 60000, windowsHide: true });
    const extracted = path.join(outDir, path.basename(getCliBinary()));
    if (!fs.existsSync(extracted)) throw new Error('The arduino-cli download did not contain the arduino-cli program.');
    fs.copyFileSync(extracted, getCliBinary());
    if (process.platform !== 'win32') fs.chmodSync(getCliBinary(), 0o755);
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return `arduino-cli ${ARDUINO_CLI_VERSION} installed (checksum verified)`;
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
  ], { timeout: 300000, windowsHide: true }); // 5 min timeout

  return stdout + stderr;
}

/**
 * Compile an Arduino sketch and return the .hex file contents.
 */
export async function compileSketch(sketchCode: string): Promise<{ hex: string; output: string }> {
  if (typeof sketchCode !== 'string' || sketchCode.length > 1_000_000) {
    throw new Error('The sketch is empty or too large to compile.');
  }
  const cli = getCliBinary();
  const dataDir = path.join(getToolsDir(), 'data');
  const tmpDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'e101-sketch-'));
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
    ], { timeout: 60000, windowsHide: true });

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
