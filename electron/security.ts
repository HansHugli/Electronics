import path from 'path';
import { pathToFileURL } from 'url';

/**
 * Which URLs may host the app (and so call the IPC bridge), and which may be
 * handed to the system browser. Pure, for tests.
 */

export const DEV_SERVER_URL = 'http://localhost:5174';

export interface AppOrigin {
  isDev: boolean;
  /** Absolute path of the packaged index.html. */
  indexFile: string;
}

/** True for the app's own page: the dev server in development, our index.html in production. */
export function isAppUrl(raw: string | undefined | null, origin: AppOrigin): boolean {
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (origin.isDev) {
    return url.protocol === 'http:' && url.host === new URL(DEV_SERVER_URL).host;
  }
  if (url.protocol !== 'file:') return false;
  const expected = pathToFileURL(path.resolve(origin.indexFile));
  return decodeURIComponent(url.pathname).toLowerCase() === decodeURIComponent(expected.pathname).toLowerCase();
}

/** Only plain https links go to the system browser. */
export function isSafeExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}
