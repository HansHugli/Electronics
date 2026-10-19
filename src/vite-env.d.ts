/// <reference types="vite/client" />

declare module 'intel-hex' {
  export function parse(data: string): { data: Buffer };
}

interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface ChatStreamHandlers {
  onToken?: (e: { requestId: string; delta: string }) => void;
  /** The model answering this conversation and a one-line reason. */
  onModel?: (e: { requestId: string; model: string; reason?: string }) => void;
  onToolCalls?: (e: {
    requestId: string;
    toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  }) => void;
  /** Visible notices: cut-off reply, refusal, step limit, stopped, tool timeout. */
  onNotice?: (e: { requestId: string; kind: string; message: string }) => void;
  onDone?: (e: {
    requestId: string;
    stopReason: string | null;
    /** Summed over every API round of the turn. */
    usage: ChatUsage;
    /** USD estimate; null when the model's price is unknown. */
    cost?: number | null;
    rounds?: number;
    model?: string;
  }) => void;
  onError?: (e: { requestId: string; kind: string; message: string; usage?: ChatUsage; cost?: number | null }) => void;
}

interface UsageRecord {
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** USD estimate; null when the model's price is unknown. */
  cost: number | null;
  rounds?: number;
  pricingVersion?: number;
}

interface ModelPricingRow {
  model: string;
  label: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  note?: string;
  legacy?: boolean;
}

interface AppConfigSafe {
  dataFilePath: string;
  hasApiKey?: boolean;
  /** How the key is stored: encrypted with the OS keychain, or plaintext where that isn't available. */
  keyStorage?: 'encrypted' | 'plaintext' | 'none';
  chatModel?: string;
  sidebarWidth?: number;
  circuitContextMode?: 'always' | 'on-change' | 'never';
}

interface DataStatus {
  dataDir: string;
  ok: boolean;
  /** A sentence to show the user, e.g. a missing data folder or a damaged settings file. */
  problem?: string;
}

/**
 * The preload bridge. Save/open/autosave calls reject with an Error whose
 * message is a plain sentence that can be shown as-is.
 */
interface ElectronApi {
  appName: string;
  getVersion: () => Promise<string>;
  saveCircuit: (data: string, currentPath?: string) => Promise<{ filePath: string; name: string } | null>;
  loadCircuit: () => Promise<{ filePath: string; name: string; data: string } | null>;
  getConfig: () => Promise<AppConfigSafe>;
  getDataStatus: () => Promise<DataStatus>;
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
  arduinoSetup: () => Promise<{ success: boolean; messages: string[]; error?: string }>;
  arduinoCompile: (sketchCode: string) => Promise<{ success: boolean; hex?: string; output?: string; error?: string }>;
  arduinoOpenSketch: () => Promise<{ filePath: string; name: string; data: string } | null>;
  arduinoSaveHex: (sketchFilePath: string, hexContent: string) => Promise<{ success: boolean; hexPath?: string; error?: string }>;

  /**
   * Main intercepts the window's close and calls `cb` instead. The renderer
   * calls confirmClose() to really close. If no handler answers within 5 s
   * (crash, hang) main closes anyway. Returns an unsubscribe function.
   */
  onCloseRequest: (cb: () => void) => () => void;
  confirmClose: () => void;

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
  usagePricing: () => Promise<ModelPricingRow[]>;
  chatSend: (payload: {
    requestId: string;
    /** Main keeps the full history (tool calls included) per conversation. */
    conversationId?: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    circuitContext: string;
    componentCatalog: string;
  }) => Promise<{ started: boolean }>;
  /** Stop a running request; resolves true if one was running. */
  chatCancel: (requestId: string) => Promise<boolean>;
  chatResetConversation: (conversationId: string) => Promise<boolean>;
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
