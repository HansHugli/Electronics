import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { autosaveFileName, defaultDataDir, oneDriveRoots } from './dataPaths';
import { archiveNameFor, checkDownloadUrl, expectedSha256, sha256File, tarCommand } from './arduinoDownload';
import { isAppUrl, isSafeExternalUrl } from './security';
import { capRecords, repriceLegacy, USAGE_MAX_RECORDS, UsageStore } from './usageStore';

const probe = (existing: string[], listing: Record<string, string[]> = {}) => ({
  exists: (p: string) => existing.includes(p),
  list: (p: string) => listing[p] ?? [],
});

describe('OneDrive detection (D5)', () => {
  const home = 'C:\\Users\\hans';
  it('prefers the env vars the OneDrive client sets', () => {
    const env = { OneDrive: 'D:\\OneDrive', OneDriveConsumer: 'D:\\OneDrive', OneDriveCommercial: 'E:\\OneDrive - Work' };
    const roots = oneDriveRoots(env, home, 'win32', probe(['D:\\OneDrive', 'E:\\OneDrive - Work']));
    expect(roots).toEqual(['D:\\OneDrive', 'E:\\OneDrive - Work']);
    expect(defaultDataDir(env, home, 'win32', probe(['D:\\OneDrive']), 'U')).toBe(path.join('D:\\OneDrive', 'Documents', 'e101'));
  });

  it('falls back to ~/OneDrive, then userData', () => {
    const legacy = path.join(home, 'OneDrive');
    expect(defaultDataDir({}, home, 'win32', probe([legacy]), 'U')).toBe(path.join(legacy, 'Documents', 'e101'));
    expect(defaultDataDir({ OneDrive: 'Z:\\gone' }, home, 'win32', probe([]), 'U')).toBe('U');
  });

  it('finds macOS CloudStorage variants', () => {
    const cloud = path.join('/Users/h', 'Library', 'CloudStorage');
    const biz = path.join(cloud, 'OneDrive-Contoso');
    const roots = oneDriveRoots({}, '/Users/h', 'darwin', probe([biz], { [cloud]: ['Dropbox', 'OneDrive-Contoso'] }));
    expect(roots).toEqual([biz]);
    expect(defaultDataDir({}, '/Users/h', 'darwin', probe([biz], { [cloud]: ['OneDrive-Contoso'] }), 'U')).toBe(path.join(biz, 'e101'));
  });

  it('names the autosave per machine', () => {
    expect(autosaveFileName('ULTIMATE')).toBe('autosave-ultimate.ecx');
    expect(autosaveFileName('Hans-Pro-MacBook.local')).toBe('autosave-hans-pro-macbook-local.ecx');
    expect(autosaveFileName('../..')).toBe('autosave-this-pc.ecx');
  });
});

describe('arduino-cli download (S4)', () => {
  it('pins 1.1.1 with published checksums and fails closed otherwise', () => {
    const win = archiveNameFor('win32', 'x64');
    expect(win).toBe('arduino-cli_1.1.1_Windows_64bit.zip');
    expect(expectedSha256(win as string)).toBe('f49a61865ff5d91d2732a19c51b0ac767cce51213db84b0b28b98ee070879f66');
    expect(expectedSha256('arduino-cli_9.9.9_Windows_64bit.zip')).toBeNull();
    expect(archiveNameFor('freebsd' as NodeJS.Platform, 'x64')).toBeNull();
    expect(expectedSha256(archiveNameFor('darwin', 'arm64') as string)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('only allows https on known hosts', () => {
    expect(checkDownloadUrl('https://downloads.arduino.cc/x.zip').hostname).toBe('downloads.arduino.cc');
    expect(() => checkDownloadUrl('http://downloads.arduino.cc/x.zip')).toThrow(/non-https/);
    expect(() => checkDownloadUrl('https://evil.example/x.zip')).toThrow(/unexpected host/);
    expect(() => checkDownloadUrl('file:///C:/x.zip')).toThrow();
  });

  it('uses the system tar by absolute path', () => {
    expect(tarCommand('win32', { SystemRoot: 'C:\\Windows' })).toBe(path.join('C:\\Windows', 'System32', 'tar.exe'));
    expect(tarCommand('darwin')).toBe('/usr/bin/tar');
  });

  it('hashes files', async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e101-h-')), 'x');
    fs.writeFileSync(f, 'abc');
    expect(await sha256File(f)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('navigation and IPC origin (S1)', () => {
  const index = path.resolve('/app/dist/index.html');
  it('accepts only our page', () => {
    expect(isAppUrl('http://localhost:5174/', { isDev: true, indexFile: index })).toBe(true);
    expect(isAppUrl('http://localhost:5175/', { isDev: true, indexFile: index })).toBe(false);
    expect(isAppUrl('https://example.com/', { isDev: true, indexFile: index })).toBe(false);
    const fileUrl = new URL(`file:///${index.replace(/\\/g, '/').replace(/^\//, '')}`).toString();
    expect(isAppUrl(fileUrl, { isDev: false, indexFile: index })).toBe(true);
    expect(isAppUrl('file:///C:/Users/x/evil.html', { isDev: false, indexFile: index })).toBe(false);
    expect(isAppUrl('http://localhost:5174/', { isDev: false, indexFile: index })).toBe(false);
    expect(isAppUrl(undefined, { isDev: false, indexFile: index })).toBe(false);
  });

  it('opens only https links externally', () => {
    expect(isSafeExternalUrl('https://www.ti.com/lit/ds/symlink/ne555.pdf')).toBe(true);
    expect(isSafeExternalUrl('http://example.com')).toBe(false);
    expect(isSafeExternalUrl('file:///C:/Windows/system32/calc.exe')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('https://user:pw@example.com')).toBe(false);
  });
});

describe('usage file (U6)', () => {
  it('keeps at most 5,000 records and nothing older than a year', () => {
    const now = Date.parse('2026-10-18T00:00:00Z');
    const old = { timestamp: '2025-01-01T00:00:00Z', model: 'm', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
    const recent = Array.from({ length: USAGE_MAX_RECORDS + 10 }, (_, i) => ({ ...old, timestamp: new Date(now - i * 1000).toISOString() })).reverse();
    const capped = capRecords([old, ...recent], now);
    expect(capped).toHaveLength(USAGE_MAX_RECORDS);
    expect(capped.includes(old)).toBe(false);
    expect(capped[capped.length - 1]).toBe(recent[recent.length - 1]);
  });

  it('re-prices legacy records and leaves new ones alone', () => {
    const legacy = { timestamp: 't', model: 'claude-opus-4-6', inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 15 };
    expect(repriceLegacy(legacy).cost).toBeCloseTo(5);
    const unknown = { ...legacy, model: 'claude-x' };
    expect(repriceLegacy(unknown).cost).toBeNull();
    const v2 = { ...legacy, cost: 1.23, pricingVersion: 2 };
    expect(repriceLegacy(v2).cost).toBe(1.23);
  });

  it('appends atomically and clears', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e101-u-')), 'usage.json');
    const store = new UsageStore(f);
    store.append({ timestamp: new Date().toISOString(), model: 'claude-sonnet-5-5', inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.1, pricingVersion: 2 });
    expect(store.load()).toHaveLength(1);
    store.clear();
    expect(store.load()).toEqual([]);
  });
});
