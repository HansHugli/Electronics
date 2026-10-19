import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWriteFileSync, friendlyFsError, isInside, isValidCircuitName, isValidTypeId, resolveInside } from './fsSafe';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e101-fs-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('isValidTypeId', () => {
  it.each(['resistor', 'gate_and', 'relay-spdt', 'a', 'x1'])('accepts %s', (id) => expect(isValidTypeId(id)).toBe(true));
  it.each([
    '../e101-config',
    '..\\..\\x',
    'e101-config.json',
    'Relay',
    '1abc',
    '',
    'a/b',
    'a'.repeat(42),
    'con\0',
    null,
    42,
  ])('rejects %s', (id) => expect(isValidTypeId(id)).toBe(false));
});

describe('isValidCircuitName', () => {
  it.each(['LED Blink Demo', '5x7 Matrix Demo', '7-Seg Counter Demo', 'my_circuit (2)'])('accepts %s', (n) =>
    expect(isValidCircuitName(n)).toBe(true));
  it.each(['../evil', '..', 'a/b', 'a\\b', 'C:x', '.hidden', 'x..y', 'trailing.', ''])('rejects %s', (n) =>
    expect(isValidCircuitName(n)).toBe(false));
});

describe('resolveInside', () => {
  it('keeps a plain name in the folder', () => {
    expect(resolveInside(dir, 'chip.json')).toBe(path.join(dir, 'chip.json'));
  });

  it.each(['../x.json', '..\\x.json', '/etc/passwd', 'C:\\Windows\\x', 'sub/x.json', '..', '.', ''])(
    'rejects traversal %s',
    (name) => {
      expect(() => resolveInside(dir, name)).toThrow();
    },
  );

  it('isInside handles prefixes correctly', () => {
    expect(isInside(dir, path.join(dir, 'a'))).toBe(true);
    expect(isInside(dir, `${dir}-evil`)).toBe(false);
    expect(isInside(dir, path.join(dir, '..', 'x'))).toBe(false);
  });
});

describe('atomicWriteFileSync', () => {
  it('writes, replaces and keeps a .bak when asked', () => {
    const f = path.join(dir, 'sub', 'autosave.ecx');
    atomicWriteFileSync(f, 'one', { backup: true });
    expect(fs.readFileSync(f, 'utf-8')).toBe('one');
    expect(fs.existsSync(`${f}.bak`)).toBe(false);
    atomicWriteFileSync(f, 'two', { backup: true });
    expect(fs.readFileSync(f, 'utf-8')).toBe('two');
    expect(fs.readFileSync(`${f}.bak`, 'utf-8')).toBe('one');
    atomicWriteFileSync(f, 'three');
    expect(fs.readFileSync(`${f}.bak`, 'utf-8')).toBe('one');
  });

  it('leaves no temp files behind', () => {
    const f = path.join(dir, 'x.json');
    for (let i = 0; i < 5; i++) atomicWriteFileSync(f, String(i), { backup: true });
    expect(fs.readdirSync(dir).sort()).toEqual(['x.json', 'x.json.bak']);
  });

  it('keeps the old file when the write fails', () => {
    const f = path.join(dir, 'keep.json');
    atomicWriteFileSync(f, 'good');
    // Target is a directory: rename fails, old content stays, temp removed.
    const asDir = path.join(dir, 'adir');
    fs.mkdirSync(asDir);
    fs.writeFileSync(path.join(asDir, 'child'), 'x');
    expect(() => atomicWriteFileSync(asDir, 'bad')).toThrow();
    expect(fs.readFileSync(f, 'utf-8')).toBe('good');
    expect(fs.readdirSync(dir).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });
});

describe('friendlyFsError', () => {
  it('turns codes into sentences', () => {
    const e = friendlyFsError('save', 'C:\\x\\a.ecx', Object.assign(new Error('x'), { code: 'EPERM' }));
    expect(e.message).toMatch(/^Could not save "a\.ecx": access was denied/);
    expect(friendlyFsError('open', '/x/b.ecx', { code: 'ENOENT' }).message).toMatch(/no longer exists/);
  });
});
