import { contextBridge, ipcRenderer } from 'electron';

/**
 * The renderer's only bridge to the main process. Every call goes through
 * `invoke`, which turns Electron's "Error invoking remote method ..." wrapper
 * back into the plain sentence main threw, so the UI can show it as-is.
 */
async function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const clean = raw.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '');
    throw new Error(clean);
  }
}

type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

const closeRequestHandlers = new Set<() => void>();
ipcRenderer.on('app:close-request', () => {
  if (closeRequestHandlers.size === 0) {
    // Nothing to guard: close straight away.
    ipcRenderer.send('app:confirm-close');
    return;
  }
  // Tell main we're alive and asking the user, so it doesn't force-close.
  ipcRenderer.send('app:close-request-ack');
  for (const cb of closeRequestHandlers) {
    try { cb(); } catch (e) { console.error(e); }
  }
});

contextBridge.exposeInMainWorld('electronApi', {
  appName: 'E101 Electronics Simulator',
  getVersion: () => invoke('get-version'),
  saveCircuit: (data: string, currentPath?: string) => invoke('save-circuit', data, currentPath),
  saveCircuitAs: (data: string, defaultPath?: string) => invoke('save-circuit-as', data, defaultPath),
  loadCircuit: () => invoke('load-circuit'),
  getConfig: () => invoke('get-config'),
  getDataStatus: () => invoke('app:get-data-status'),
  loadChips: () => invoke('load-chips'),
  saveChip: (chipJson: unknown) => invoke('save-chip', chipJson),
  deleteChip: (typeId: string) => invoke('delete-chip', typeId),
  loadHex: () => invoke('load-hex'),
  autosave: (data: string) => invoke('autosave', data),
  loadAutosave: () => invoke('load-autosave'),
  saveDemo: (name: string, data: string) => invoke('save-demo', name, data),
  loadNamedCircuit: (name: string) => invoke('load-named-circuit', name),
  setTitle: (title: string) => ipcRenderer.send('set-title', title),
  arduinoStatus: () => invoke('arduino-status'),
  arduinoSetup: () => invoke('arduino-setup'),
  arduinoCompile: (sketchCode: string) => invoke('arduino-compile', sketchCode),
  arduinoOpenSketch: () => invoke('arduino-open-sketch'),
  arduinoSaveHex: (sketchFilePath: string, hexContent: string) => invoke('arduino-save-hex', sketchFilePath, hexContent),

  // ---- Window close guard ---- //
  onCloseRequest: (cb: () => void) => {
    closeRequestHandlers.add(cb);
    return () => {
      closeRequestHandlers.delete(cb);
    };
  },
  confirmClose: () => ipcRenderer.send('app:confirm-close'),

  // ---- Claude Chat ---- //
  chatSetApiKey: (apiKey: string) => invoke('chat-set-api-key', apiKey),
  chatClearApiKey: () => invoke('chat-clear-api-key'),
  chatSetModel: (model: string) => invoke('chat-set-model', model),
  chatSetCircuitMode: (mode: 'always' | 'on-change' | 'never') => invoke('chat-set-circuit-mode', mode),
  chatSetSidebarWidth: (width: number) => invoke('chat-set-sidebar-width', width),
  usageRecord: (record: { model: string } & Usage) => invoke('usage-record', record),
  usageGet: () => invoke('usage-get'),
  usageClear: () => invoke('usage-clear'),
  usagePricing: () => invoke('usage-pricing'),
  chatSend: (payload: {
    requestId: string;
    conversationId?: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    circuitContext: string;
    componentCatalog: string;
  }) => invoke('chat-send', payload),
  chatCancel: (requestId: string) => invoke('chat-cancel', requestId),
  chatResetConversation: (conversationId: string) => invoke('chat-reset-conversation', conversationId),
  // Subscribe to streaming events. Returns an unsubscribe function.
  onChatStream: (handlers: {
    onToken?: (e: { requestId: string; delta: string }) => void;
    onModel?: (e: { requestId: string; model: string; reason?: string }) => void;
    onToolCalls?: (e: {
      requestId: string;
      toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
    }) => void;
    onNotice?: (e: { requestId: string; kind: string; message: string }) => void;
    onDone?: (e: {
      requestId: string;
      stopReason: string | null;
      usage: Usage;
      cost?: number | null;
      rounds?: number;
      model?: string;
    }) => void;
    onError?: (e: { requestId: string; kind: string; message: string; usage?: Usage; cost?: number | null }) => void;
  }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pairs: [string, ((payload: any) => void) | undefined][] = [
      ['chat-stream-token', handlers.onToken],
      ['chat-stream-model', handlers.onModel],
      ['chat-stream-tool-calls', handlers.onToolCalls],
      ['chat-stream-notice', handlers.onNotice],
      ['chat-stream-done', handlers.onDone],
      ['chat-stream-error', handlers.onError],
    ];
    const listeners = pairs.map(([channel, cb]) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: unknown) => cb?.(payload);
      ipcRenderer.on(channel, listener);
      return [channel, listener] as const;
    });
    return () => {
      for (const [channel, listener] of listeners) ipcRenderer.off(channel, listener);
    };
  },
  /** Send tool execution results back to the main process. */
  chatSendToolResults: (
    requestId: string,
    results: { id: string; result: { success: boolean; message: string; data?: Record<string, unknown> } }[],
  ) => ipcRenderer.send(`chat-tool-result-${requestId}`, results),

  onMenuAction: (callback: (action: string) => void) => {
    ipcRenderer.removeAllListeners('menu-action');
    ipcRenderer.on('menu-action', (_event, action: string) => callback(action));
  },
});
