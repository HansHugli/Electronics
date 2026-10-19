import path from 'path';

/**
 * Where E101 keeps its data. Pure functions (file-system access is injected)
 * so the detection rules can be unit-tested for every platform.
 */

export interface FsProbe {
  exists: (p: string) => boolean;
  /** Folder entries, or [] when the folder can't be read. */
  list: (p: string) => string[];
}

/**
 * OneDrive roots in order of preference. On Windows the OneDrive client sets
 * `OneDrive` (the default account), `OneDriveConsumer` (personal) and
 * `OneDriveCommercial` (work or school); `~/OneDrive` is the legacy default.
 * On macOS the client lives under ~/Library/CloudStorage/OneDrive-*.
 */
export function oneDriveRoots(
  env: Record<string, string | undefined>,
  home: string,
  platform: NodeJS.Platform,
  probe: FsProbe,
): string[] {
  const out: string[] = [];
  const add = (p: string | undefined) => {
    if (p && !out.includes(p) && probe.exists(p)) out.push(p);
  };
  if (platform === 'win32') {
    add(env.OneDriveConsumer);
    add(env.OneDrive);
    add(env.OneDriveCommercial);
    add(path.join(home, 'OneDrive'));
  } else if (platform === 'darwin') {
    const cloud = path.join(home, 'Library', 'CloudStorage');
    add(path.join(cloud, 'OneDrive-Personal'));
    for (const entry of probe.list(cloud).sort()) {
      if (entry.startsWith('OneDrive')) add(path.join(cloud, entry));
    }
    add(path.join(home, 'OneDrive'));
  }
  return out;
}

/** The data folder for a fresh install: OneDrive when present, else userData. */
export function defaultDataDir(
  env: Record<string, string | undefined>,
  home: string,
  platform: NodeJS.Platform,
  probe: FsProbe,
  userData: string,
): string {
  const roots = oneDriveRoots(env, home, platform, probe);
  if (roots.length === 0) return userData;
  // Windows has always used <OneDrive>/Documents/e101; macOS <OneDrive>/e101.
  return platform === 'win32' ? path.join(roots[0], 'Documents', 'e101') : path.join(roots[0], 'e101');
}

/** Autosave file for this machine, so two PCs sharing OneDrive don't overwrite each other. */
export function autosaveFileName(hostname: string): string {
  const safe = hostname.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `autosave-${safe || 'this-pc'}.ecx`;
}

export const LEGACY_AUTOSAVE_NAME = 'autosave.ecx';
