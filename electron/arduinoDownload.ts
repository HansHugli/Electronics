import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import path from 'path';

/**
 * Verified arduino-cli download. The version is pinned and every archive's
 * SHA-256 below is copied from the official release checksums file
 * (https://github.com/arduino/arduino-cli/releases/download/v1.1.1/1.1.1-checksums.txt,
 * fetched 2026-10-19; the Windows 64-bit zip on downloads.arduino.cc was
 * re-hashed and matches). An archive without a checksum here is refused.
 */

export const ARDUINO_CLI_VERSION = '1.1.1';

export const ARDUINO_CLI_SHA256: Record<string, string> = {
  'arduino-cli_1.1.1_Windows_64bit.zip': 'f49a61865ff5d91d2732a19c51b0ac767cce51213db84b0b28b98ee070879f66',
  'arduino-cli_1.1.1_Windows_32bit.zip': 'ab9ced1036d4fa8648bd25382e0f5493a500c7deb62f7d5a6008bbdf3e8e5ffc',
  'arduino-cli_1.1.1_macOS_64bit.tar.gz': 'ef1a43afe18209a1a56e5f8974b561811c6743e8aa456dadb090b56c555131aa',
  'arduino-cli_1.1.1_macOS_ARM64.tar.gz': '36bad14f51d68696e8d97947dbde3a774942cc9d0c83d2a00aa26c22ea9167a3',
  'arduino-cli_1.1.1_Linux_64bit.tar.gz': '2b807add5c3a518861bfd4d3e78de9e02b0a2723df3d90386df2200a767349c4',
  'arduino-cli_1.1.1_Linux_ARM64.tar.gz': 'b6a18d39d574b94e8221b5d0afe79d20d846227b4959ff95e44279021593b199',
};

/** Hosts a download may come from (the CDN and GitHub release redirects). */
export const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'downloads.arduino.cc',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

export function archiveNameFor(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === 'win32') {
    // No Windows ARM64 build exists for 1.1.1; the x64 build runs under emulation.
    return `arduino-cli_${ARDUINO_CLI_VERSION}_Windows_${arch === 'ia32' ? '32bit' : '64bit'}.zip`;
  }
  if (platform === 'darwin') return `arduino-cli_${ARDUINO_CLI_VERSION}_macOS_${arch === 'arm64' ? 'ARM64' : '64bit'}.tar.gz`;
  if (platform === 'linux') return `arduino-cli_${ARDUINO_CLI_VERSION}_Linux_${arch === 'arm64' ? 'ARM64' : '64bit'}.tar.gz`;
  return null;
}

export function expectedSha256(archive: string): string | null {
  return ARDUINO_CLI_SHA256[archive] ?? null;
}

/** The system tar by absolute path (Windows 10+ ships bsdtar, which reads zip). */
export function tarCommand(platform: NodeJS.Platform, env: Record<string, string | undefined> = process.env): string {
  if (platform === 'win32') return path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return '/usr/bin/tar';
}

/** Only https URLs on the allow-listed hosts may be fetched or redirected to. */
export function checkDownloadUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('The download address is not a valid URL.');
  }
  if (url.protocol !== 'https:') throw new Error(`Refusing a non-https download (${url.protocol}).`);
  if (!ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)) throw new Error(`Refusing a download from an unexpected host (${url.hostname}).`);
  return url;
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

const MAX_BYTES = 200 * 1024 * 1024;

/** Download over https (validated redirects), then require the expected SHA-256. */
export async function downloadVerified(url: string, dest: string, sha256: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const follow = (u: string, depth: number) => {
      let target: URL;
      try {
        target = checkDownloadUrl(u);
      } catch (err) {
        reject(err);
        return;
      }
      if (depth > 5) { reject(new Error('Too many redirects while downloading arduino-cli.')); return; }
      https.get(target, (res) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          const loc = res.headers.location;
          if (!loc) { reject(new Error('The download redirected without a location.')); return; }
          follow(new URL(loc, target).toString(), depth + 1);
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`The arduino-cli download failed (HTTP ${status}).`));
          return;
        }
        let bytes = 0;
        const file = fs.createWriteStream(dest);
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) {
            res.destroy(new Error('The arduino-cli download is unexpectedly large.'));
          }
        });
        res.on('error', (e) => { file.destroy(); reject(e); });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
      }).on('error', (e) => reject(new Error(`Could not download arduino-cli: ${e.message}`)));
    };
    follow(url, 0);
  });
  const actual = await sha256File(dest);
  if (actual.toLowerCase() !== sha256.toLowerCase()) {
    try { fs.unlinkSync(dest); } catch { /* ignore */ }
    throw new Error('The arduino-cli download failed its checksum check and was deleted. Try again later.');
  }
}
