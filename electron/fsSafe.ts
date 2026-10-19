import fs from 'fs';
import path from 'path';

/**
 * File-system helpers for the main process: name validation, path
 * containment and atomic writes. Pure Node (no Electron imports) so the unit
 * tests can run them against a temp folder.
 */

/** Component type IDs (also chip file names): lowercase, digits, `_` and `-`. */
export const TYPE_ID_RE = /^[a-z][a-z0-9_-]{0,40}$/;

/** Circuit names used for files in the circuits folder (demos, named loads). */
export const CIRCUIT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,79}$/;

export function isValidTypeId(value: unknown): value is string {
  return typeof value === 'string' && TYPE_ID_RE.test(value);
}

export function isValidCircuitName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    CIRCUIT_NAME_RE.test(value) &&
    !value.includes('..') &&
    !value.endsWith('.') &&
    !value.endsWith(' ')
  );
}

/** True when `child` is `base` or lies inside it (after resolving both). */
export function isInside(base: string, child: string): boolean {
  const b = path.resolve(base);
  const c = path.resolve(child);
  if (c === b) return true;
  const rel = path.relative(b, c);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Join a file name onto a folder and make sure the result stays directly in
 * that folder. Throws on anything that would escape it (`..`, separators,
 * absolute paths, drive letters).
 */
export function resolveInside(baseDir: string, fileName: string): string {
  if (typeof fileName !== 'string' || fileName.length === 0) {
    throw new Error('The file name is empty.');
  }
  if (/[\\/:\0]/.test(fileName) || fileName === '.' || fileName === '..') {
    throw new Error(`"${fileName}" is not a valid file name.`);
  }
  const resolved = path.resolve(baseDir, fileName);
  if (path.dirname(resolved) !== path.resolve(baseDir) || !isInside(baseDir, resolved)) {
    throw new Error(`"${fileName}" is not a valid file name.`);
  }
  return resolved;
}

export interface AtomicWriteOptions {
  /** Copy the existing file to `<file>.bak` before replacing it. */
  backup?: boolean;
}

function tempName(file: string): string {
  return `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function sleepSync(ms: number) {
  // Synchronous short wait for rename retries (OneDrive / antivirus can hold
  // a file for a moment). Atomics.wait blocks without spinning the CPU.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write a file atomically: write a temp file in the same folder, flush it,
 * then rename it over the target. A crash leaves either the old or the new
 * file, never a half-written one. Optionally keeps the previous version as
 * `<file>.bak`.
 */
export function atomicWriteFileSync(file: string, data: string, opts: AtomicWriteOptions = {}): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = tempName(file);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data, 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (opts.backup && fs.existsSync(file)) {
      try {
        fs.copyFileSync(file, `${file}.bak`);
      } catch {
        // A failed backup must not block the save itself.
      }
    }
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (err) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException).code;
        if (!code || !RETRY_CODES.has(code)) break;
        sleepSync(40 * (attempt + 1));
      }
    }
    throw lastErr;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/** Async wrapper with the same guarantees (kept sync inside: files are small). */
export async function atomicWriteFile(file: string, data: string, opts: AtomicWriteOptions = {}): Promise<void> {
  atomicWriteFileSync(file, data, opts);
}

/** Turn a Node fs error into a sentence a user can act on. */
export function friendlyFsError(action: 'save' | 'open' | 'delete', file: string, err: unknown): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const name = path.basename(file);
  const verb = action === 'save' ? 'save' : action === 'open' ? 'open' : 'delete';
  let why: string;
  switch (code) {
    case 'ENOENT':
      why = action === 'open' ? 'the file no longer exists' : 'its folder does not exist';
      break;
    case 'EACCES':
    case 'EPERM':
      why = 'access was denied (the file may be read-only, open in another program, or being synced)';
      break;
    case 'EBUSY':
      why = 'the file is in use by another program';
      break;
    case 'ENOSPC':
      why = 'the disk is full';
      break;
    case 'EROFS':
      why = 'the drive is read-only';
      break;
    default:
      why = (err as Error | undefined)?.message || 'an unknown error occurred';
  }
  return new Error(`Could not ${verb} "${name}": ${why}.`);
}
