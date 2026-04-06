/// <reference types="vite/client" />

declare module 'intel-hex' {
  export function parse(data: string): { data: Buffer };
}

interface ElectronApi {
  appName: string;
  getVersion: () => Promise<string>;
  saveCircuit: (data: string, currentPath?: string) => Promise<{ filePath: string; name: string } | null>;
  loadCircuit: () => Promise<{ filePath: string; name: string; data: string } | null>;
  getConfig: () => Promise<{ dataFilePath: string }>;
  loadChips: () => Promise<unknown[]>;
  loadHex: () => Promise<{ filePath: string; name: string; data: string } | null>;
  saveDemo: (name: string, data: string) => Promise<string>;
  loadNamedCircuit: (name: string) => Promise<{ filePath: string; name: string; data: string } | null>;
  setTitle: (title: string) => void;
  arduinoStatus: () => Promise<{ cliInstalled: boolean; coreInstalled: boolean }>;
  arduinoSetup: () => Promise<{ success: boolean; messages: string[] }>;
  arduinoCompile: (sketchCode: string) => Promise<{ success: boolean; hex?: string; output?: string; error?: string }>;
  onMenuAction: (callback: (action: string) => void) => void;
}

interface Window {
  electronApi?: ElectronApi;
}
