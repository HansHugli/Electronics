/// <reference types="vite/client" />

declare module 'intel-hex' {
  export function parse(data: string): { data: Buffer };
}

interface ChatStreamHandlers {
  onToken?: (e: { requestId: string; delta: string }) => void;
  onModel?: (e: { requestId: string; model: string }) => void;
  onToolCalls?: (e: {
    requestId: string;
    toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  }) => void;
  onDone?: (e: {
    requestId: string;
    stopReason: string | null;
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  }) => void;
  onError?: (e: { requestId: string; kind: string; message: string }) => void;
}

interface UsageRecord {
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
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
  saveChip: (chipJson: unknown) => Promise<string>;
  deleteChip: (typeId: string) => Promise<{ success: boolean; message?: string }>;
  loadHex: () => Promise<{ filePath: string; name: string; data: string } | null>;
  autosave: (data: string) => Promise<string>;
  loadAutosave: () => Promise<{ data: string } | null>;
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
  usageRecord: (record: { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) =>
    Promise<UsageRecord>;
  usageGet: () => Promise<UsageRecord[]>;
  usageClear: () => Promise<UsageRecord[]>;
  chatSend: (payload: {
    requestId: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    circuitContext: string;
    componentCatalog: string;
  }) => Promise<{ started: boolean }>;
  onChatStream: (handlers: ChatStreamHandlers) => () => void;
  chatSendToolResults: (
    requestId: string,
    results: { id: string; result: { success: boolean; message: string; data?: Record<string, unknown> } }[],
  ) => void;

  onMenuAction: (callback: (action: string) => void) => void;
}

interface Window {
  electronApi?: ElectronApi;
}
