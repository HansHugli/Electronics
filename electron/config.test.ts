import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigStore } from './config';
import { Cipher, keyStorageOf, migratePlaintextKey, readApiKey, writeApiKey } from './secrets';

let dir: string;
let file: string;
const defaults = () => ({ dataFilePath: '/default/e101.json' });
const fixedNow = () => new Date('2026-10-18T12:34:56Z');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e101-cfg-'));
  file = path.join(dir, 'e101-config.json');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ConfigStore', () => {
  it('first run: defaults, and the resolved path is written on update', () => {
    const store = new ConfigStore(file, defaults);
    expect(store.firstRun).toBe(true);
    store.update(() => {});
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).dataFilePath).toBe('/default/e101.json');
  });

  it('loads and sanitises a good file', () => {
    fs.writeFileSync(file, JSON.stringify({ dataFilePath: 'D:/data/e101.json', chatModel: 'auto', bogus: 1, sidebarWidth: 'wide' }));
    const store = new ConfigStore(file, defaults);
    expect(store.problem).toBeUndefined();
    expect(store.get()).toEqual({ dataFilePath: 'D:/data/e101.json', chatModel: 'auto' });
  });

  it('never overwrites a corrupt config: keeps it, saves a dated copy, runs on defaults in memory', () => {
    const broken = '{ "dataFilePath": "D:/data/e101.json", "apiKey": "sk-ant-x", ';
    fs.writeFileSync(file, broken);
    const store = new ConfigStore(file, defaults, fixedNow);
    expect(store.writable).toBe(false);
    expect(store.get().dataFilePath).toBe('/default/e101.json');
    expect(store.problem).toMatch(/damaged/);
    expect(store.corruptCopy).toBe(`${file}.corrupt-2026-10-18T12-34-56`);
    expect(fs.readFileSync(store.corruptCopy as string, 'utf-8')).toBe(broken);

    store.update((c) => { c.chatModel = 'claude-opus-5-5'; });
    expect(store.get().chatModel).toBe('claude-opus-5-5');
    expect(fs.readFileSync(file, 'utf-8')).toBe(broken);
  });

  it('uses the last good .bak when the config is corrupt', () => {
    fs.writeFileSync(`${file}.bak`, JSON.stringify({ dataFilePath: 'D:/good/e101.json', chatModel: 'auto' }));
    fs.writeFileSync(file, 'not json');
    const store = new ConfigStore(file, defaults, fixedNow);
    expect(store.get().dataFilePath).toBe('D:/good/e101.json');
    expect(store.problem).toMatch(/backup/);
    expect(fs.readFileSync(file, 'utf-8')).toBe('not json');
  });

  it('treats a JSON array as corrupt', () => {
    fs.writeFileSync(file, '[]');
    const store = new ConfigStore(file, defaults, fixedNow);
    expect(store.writable).toBe(false);
  });

  it('writes atomically with a .bak of the previous version', () => {
    const store = new ConfigStore(file, defaults);
    store.update((c) => { c.chatModel = 'a'; });
    store.update((c) => { c.chatModel = 'b'; });
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).chatModel).toBe('b');
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf-8')).chatModel).toBe('a');
  });

  it('scrubBackup replaces the .bak too (no old key left behind)', () => {
    const store = new ConfigStore(file, defaults);
    store.update((c) => { c.apiKey = 'sk-ant-old'; });
    store.update((c) => { c.apiKey = 'sk-ant-old2'; });
    store.update((c) => { delete c.apiKey; }, { scrubBackup: true });
    expect(fs.readFileSync(`${file}.bak`, 'utf-8')).not.toMatch(/sk-ant/);
    expect(fs.readFileSync(file, 'utf-8')).not.toMatch(/sk-ant/);
  });
});

// A reversible fake of safeStorage.
const fakeCipher = (available = true): Cipher => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => {
    const t = b.toString();
    if (!t.startsWith('enc:')) throw new Error('bad');
    return t.slice(4);
  },
});

describe('API key storage', () => {
  it('encrypts new keys and reads them back', () => {
    const cfg = { dataFilePath: 'x' } as { dataFilePath: string; apiKey?: string; apiKeyEnc?: string };
    writeApiKey(cfg, '  sk-ant-123 ', fakeCipher());
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.apiKeyEnc).toBeTruthy();
    expect(JSON.stringify(cfg)).not.toMatch(/sk-ant-123/);
    expect(readApiKey(cfg, fakeCipher())).toBe('sk-ant-123');
    expect(keyStorageOf(cfg)).toBe('encrypted');
  });

  it('migrates a plaintext key once', () => {
    const cfg = { dataFilePath: 'x', apiKey: 'sk-ant-legacy' } as { dataFilePath: string; apiKey?: string; apiKeyEnc?: string };
    expect(migratePlaintextKey(cfg, fakeCipher())).toBe(true);
    expect(cfg.apiKey).toBeUndefined();
    expect(readApiKey(cfg, fakeCipher())).toBe('sk-ant-legacy');
    expect(migratePlaintextKey(cfg, fakeCipher())).toBe(false);
  });

  it('keeps plaintext when the OS has no secure storage', () => {
    const cfg = { dataFilePath: 'x', apiKey: 'sk-ant-legacy' };
    expect(migratePlaintextKey(cfg, fakeCipher(false))).toBe(false);
    expect(keyStorageOf(cfg)).toBe('plaintext');
  });

  it('clearing removes both forms', () => {
    const cfg = { dataFilePath: 'x', apiKey: 'a', apiKeyEnc: 'b' };
    writeApiKey(cfg, undefined, fakeCipher());
    expect(keyStorageOf(cfg)).toBe('none');
  });

  it('an undecryptable key reads as missing', () => {
    expect(readApiKey({ dataFilePath: 'x', apiKeyEnc: Buffer.from('junk').toString('base64') }, fakeCipher())).toBeUndefined();
  });
});
