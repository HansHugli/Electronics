import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronApi', {
  appName: 'E101 Electronics Simulator',
  getVersion: () => ipcRenderer.invoke('get-version'),
  saveCircuit: (data: string, currentPath?: string) => ipcRenderer.invoke('save-circuit', data, currentPath),
  loadCircuit: () => ipcRenderer.invoke('load-circuit'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  loadChips: () => ipcRenderer.invoke('load-chips'),
  loadHex: () => ipcRenderer.invoke('load-hex'),
  saveDemo: (name: string, data: string) => ipcRenderer.invoke('save-demo', name, data),
  loadNamedCircuit: (name: string) => ipcRenderer.invoke('load-named-circuit', name),
  setTitle: (title: string) => ipcRenderer.send('set-title', title),
  arduinoStatus: () => ipcRenderer.invoke('arduino-status'),
  arduinoSetup: () => ipcRenderer.invoke('arduino-setup'),
  arduinoCompile: (sketchCode: string) => ipcRenderer.invoke('arduino-compile', sketchCode),
  arduinoOpenSketch: () => ipcRenderer.invoke('arduino-open-sketch'),
  arduinoSaveHex: (sketchFilePath: string, hexContent: string) =>
    ipcRenderer.invoke('arduino-save-hex', sketchFilePath, hexContent),

  // ---- Claude Chat ---- //
  chatSetApiKey: (apiKey: string) => ipcRenderer.invoke('chat-set-api-key', apiKey),
  chatClearApiKey: () => ipcRenderer.invoke('chat-clear-api-key'),
  chatSetModel: (model: string) => ipcRenderer.invoke('chat-set-model', model),
  chatSetCircuitMode: (mode: 'always' | 'on-change' | 'never') =>
    ipcRenderer.invoke('chat-set-circuit-mode', mode),
  chatSetSidebarWidth: (width: number) => ipcRenderer.invoke('chat-set-sidebar-width', width),
  chatSend: (payload: {
    requestId: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    circuitContext: string;
    componentCatalog: string;
  }) => ipcRenderer.invoke('chat-send', payload),
  // Subscribe to streaming events. Returns an unsubscribe function.
  onChatStream: (handlers: {
    onToken?: (e: { requestId: string; delta: string }) => void;
    onDone?: (e: {
      requestId: string;
      stopReason: string | null;
      usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
    }) => void;
    onError?: (e: { requestId: string; kind: string; message: string }) => void;
  }) => {
    const tokenHandler = (_e: unknown, payload: { requestId: string; delta: string }) =>
      handlers.onToken?.(payload);
    const doneHandler = (
      _e: unknown,
      payload: {
        requestId: string;
        stopReason: string | null;
        usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
      },
    ) => handlers.onDone?.(payload);
    const errorHandler = (
      _e: unknown,
      payload: { requestId: string; kind: string; message: string },
    ) => handlers.onError?.(payload);
    ipcRenderer.on('chat-stream-token', tokenHandler);
    ipcRenderer.on('chat-stream-done', doneHandler);
    ipcRenderer.on('chat-stream-error', errorHandler);
    return () => {
      ipcRenderer.off('chat-stream-token', tokenHandler);
      ipcRenderer.off('chat-stream-done', doneHandler);
      ipcRenderer.off('chat-stream-error', errorHandler);
    };
  },

  onMenuAction: (callback: (action: string) => void) => {
    ipcRenderer.removeAllListeners('menu-action');
    ipcRenderer.on('menu-action', (_event, action: string) => callback(action));
  },
});
