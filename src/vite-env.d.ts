/// <reference types="vite/client" />

declare module 'intel-hex' {
  export function parse(data: string): { data: Buffer };
}

interface ElectronApi {
  appName: string;
  saveCircuit: (data: string, currentPath?: string) => Promise<{ filePath: string; name: string } | null>;
  loadCircuit: () => Promise<{ filePath: string; name: string; data: string } | null>;
  getConfig: () => Promise<{ dataFilePath: string }>;
  loadChips: () => Promise<unknown[]>;
  loadHex: () => Promise<{ filePath: string; name: string; data: string } | null>;
}

interface Window {
  electronApi?: ElectronApi;
}
