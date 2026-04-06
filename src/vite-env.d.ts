/// <reference types="vite/client" />

interface ElectronApi {
  appName: string;
  saveCircuit: (data: string, currentPath?: string) => Promise<{ filePath: string; name: string } | null>;
  loadCircuit: () => Promise<{ filePath: string; name: string; data: string } | null>;
  getConfig: () => Promise<{ dataFilePath: string }>;
}

interface Window {
  electronApi?: ElectronApi;
}
