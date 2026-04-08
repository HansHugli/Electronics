/// <reference types="vite/client" />

declare module 'intel-hex' {
  export function parse(data: string): { data: Buffer };
}

interface ChatStreamHandlers {
  onToken?: (e: { requestId: string; delta: string }) => void;
  onDone?: (e: {
    requestId: string;
    stopReason: string | null;
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  }) => void;
  onError?: (e: { requestId: string; kind: string; message: string }) => void;
}

interface AppConfigSafe {
  dataFilePath: string;
  hasApiKey?: boolean;
  chatModel?: string;
  sidebarWidth?: number;
  circuitContextMode?: 'always' | 'on-change' | 'never';
}

interface ElectronApi {
  appName: string;
  getVersion: () => Promise<string>;
  saveCircuit: (data: string, currentPath?: string) => Promise<{ filePath: string; name: string } | null>;
  loadCircuit: () => Promise<{ filePath: string; name: string; data: string } | null>;
  getConfig: () => Promise<AppConfigSafe>;
  loadChips: () => Promise<unknown[]>;
  loadHex: () => Promise<{ filePath: string; name: string; data: string } | null>;
  saveDemo: (name: string, data: string) => Promise<string>;
  loadNamedCircuit: (name: string) => Promise<{ filePath: string; name: string; data: string } | null>;
  setTitle: (title: string) => void;
  arduinoStatus: () => Promise<{ cliInstalled: boolean; coreInstalled: boolean }>;
  arduinoSetup: () => Promise<{ success: boolean; messages: string[] }>;
  arduinoCompile: (sketchCode: string) => Promise<{ success: boolean; hex?: string; output?: string; error?: string }>;
  arduinoOpenSketch: () => Promise<{ filePath: string; name: string; data: string } | null>;
  arduinoSaveHex: (sketchFilePath: string, hexContent: string) => Promise<{ success: boolean; hexPath?: string; error?: string }>;

  // Claude Chat
  chatSetApiKey: (apiKey: string) => Promise<{ hasApiKey: boolean }>;
  chatClearApiKey: () => Promise<{ hasApiKey: boolean }>;
  chatSetModel: (model: string) => Promise<string>;
  chatSetCircuitMode: (mode: 'always' | 'on-change' | 'never') => Promise<'always' | 'on-change' | 'never'>;
  chatSetSidebarWidth: (width: number) => Promise<number>;
  chatSend: (payload: {
    requestId: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    circuitContext: string;
    componentCatalog: string;
  }) => Promise<{ started: boolean }>;
  onChatStream: (handlers: ChatStreamHandlers) => () => void;

  onMenuAction: (callback: (action: string) => void) => void;
}

interface Window {
  electronApi?: ElectronApi;
}
