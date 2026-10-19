import fs from 'fs';
import path from 'path';
import { atomicWriteFileSync } from './fsSafe';

/**
 * The app config (`e101-config.json` in userData). Never overwritten when it
 * can't be parsed: the broken file stays in place, a copy is saved next to
 * it, and the app runs on the last good backup (or defaults) in memory.
 */

export type CircuitContextMode = 'always' | 'on-change' | 'never';

export interface AppConfig {
  dataFilePath: string;
  /** Legacy plaintext key (migrated to `apiKeyEnc` on start when possible). */
  apiKey?: string;
  /** API key encrypted with Electron safeStorage, base64. */
  apiKeyEnc?: string;
  chatModel?: string;
  sidebarWidth?: number;
  circuitContextMode?: CircuitContextMode;
}

export function timestampForFile(d: Date): string {
  return d.toISOString().replace(/\..+$/, '').replace(/:/g, '-');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Keep only known fields with the right types. */
export function sanitizeConfig(raw: Record<string, unknown>, defaults: AppConfig): { config: AppConfig; filled: boolean } {
  let filled = false;
  const cfg: AppConfig = { dataFilePath: defaults.dataFilePath };
  if (typeof raw.dataFilePath === 'string' && raw.dataFilePath.trim()) cfg.dataFilePath = raw.dataFilePath;
  else filled = true;
  if (typeof raw.apiKey === 'string' && raw.apiKey) cfg.apiKey = raw.apiKey;
  if (typeof raw.apiKeyEnc === 'string' && raw.apiKeyEnc) cfg.apiKeyEnc = raw.apiKeyEnc;
  if (typeof raw.chatModel === 'string') cfg.chatModel = raw.chatModel;
  if (typeof raw.sidebarWidth === 'number' && Number.isFinite(raw.sidebarWidth)) cfg.sidebarWidth = raw.sidebarWidth;
  if (raw.circuitContextMode === 'always' || raw.circuitContextMode === 'on-change' || raw.circuitContextMode === 'never') {
    cfg.circuitContextMode = raw.circuitContextMode;
  }
  return { config: cfg, filled };
}

function tryParse(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export class ConfigStore {
  private config: AppConfig;
  /** False when the file on disk is unreadable: changes stay in memory. */
  writable = true;
  /** True when no config file existed (a fresh install). */
  firstRun = false;
  problem: string | undefined;
  corruptCopy: string | undefined;

  constructor(
    readonly file: string,
    private readonly makeDefaults: () => AppConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.config = this.load();
  }

  private load(): AppConfig {
    const defaults = this.makeDefaults();
    if (!fs.existsSync(this.file)) {
      this.firstRun = true;
      return defaults;
    }
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf-8');
    } catch (err) {
      this.writable = false;
      this.problem =
        `Your settings file ${path.basename(this.file)} could not be read (${(err as NodeJS.ErrnoException).code ?? 'error'}). ` +
        'E101 is using default settings for now and will not change the file.';
      return defaults;
    }
    let parsed: unknown;
    let parseOk = true;
    try {
      parsed = JSON.parse(text);
    } catch {
      parseOk = false;
    }
    if (parseOk && isPlainObject(parsed)) {
      const { config, filled } = sanitizeConfig(parsed, defaults);
      if (filled) this.save(config);
      return config;
    }

    // Corrupt: keep the original untouched, save a copy, use the backup.
    this.writable = false;
    const copy = `${this.file}.corrupt-${timestampForFile(this.now())}`;
    try {
      fs.copyFileSync(this.file, copy);
      this.corruptCopy = copy;
    } catch {
      /* the original is still there */
    }
    const backup = tryParse(`${this.file}.bak`);
    const usingBackup = !!backup;
    const config = backup ? sanitizeConfig(backup, defaults).config : defaults;
    this.problem =
      `Your settings file ${path.basename(this.file)} is damaged and could not be read. ` +
      `It was left as it is${this.corruptCopy ? ` and a copy was saved as ${path.basename(this.corruptCopy)}` : ''}. ` +
      `E101 is running with ${usingBackup ? 'your last good settings (from the backup)' : 'default settings'} and won't change the file. ` +
      'Repair or delete it, then restart E101.';
    return config;
  }

  get(): AppConfig {
    return { ...this.config };
  }

  /** Apply a change and persist it (atomically, keeping a .bak) when the file is writable. */
  update(mutate: (cfg: AppConfig) => void, opts: { scrubBackup?: boolean } = {}): AppConfig {
    const next = { ...this.config };
    mutate(next);
    this.config = next;
    if (this.writable) this.save(next, opts.scrubBackup);
    return { ...next };
  }

  /**
   * `scrubBackup` also replaces the .bak with the new content, for changes
   * (like removing a plaintext API key) that must not linger in the backup.
   */
  private save(cfg: AppConfig, scrubBackup = false) {
    const text = JSON.stringify(cfg, null, 2);
    atomicWriteFileSync(this.file, text, { backup: !scrubBackup });
    if (scrubBackup) atomicWriteFileSync(`${this.file}.bak`, text);
  }
}
