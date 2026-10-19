import type { AppConfig } from './config';

/**
 * API key storage. The key is encrypted with Electron's safeStorage (DPAPI on
 * Windows, Keychain on macOS) and only ever decrypted in the main process.
 * The cipher is injected so this logic can be tested without Electron.
 */

export interface Cipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export type KeyStorage = 'encrypted' | 'plaintext' | 'none';

export function keyStorageOf(cfg: AppConfig): KeyStorage {
  if (cfg.apiKeyEnc) return 'encrypted';
  if (cfg.apiKey) return 'plaintext';
  return 'none';
}

/** Decrypt the stored key, or return the legacy plaintext one. Never logs it. */
export function readApiKey(cfg: AppConfig, cipher: Cipher): string | undefined {
  if (cfg.apiKeyEnc) {
    try {
      return cipher.decryptString(Buffer.from(cfg.apiKeyEnc, 'base64')) || undefined;
    } catch {
      return undefined;
    }
  }
  return cfg.apiKey || undefined;
}

/** Store a new key: encrypted when the OS supports it, plaintext otherwise. */
export function writeApiKey(cfg: AppConfig, key: string | undefined, cipher: Cipher): void {
  delete cfg.apiKey;
  delete cfg.apiKeyEnc;
  const trimmed = key?.trim();
  if (!trimmed) return;
  if (cipher.isEncryptionAvailable()) {
    cfg.apiKeyEnc = cipher.encryptString(trimmed).toString('base64');
  } else {
    cfg.apiKey = trimmed;
  }
}

/** One-time migration of a legacy plaintext key. Returns true when cfg changed. */
export function migratePlaintextKey(cfg: AppConfig, cipher: Cipher): boolean {
  if (!cfg.apiKey || cfg.apiKeyEnc || !cipher.isEncryptionAvailable()) return false;
  writeApiKey(cfg, cfg.apiKey, cipher);
  return true;
}
