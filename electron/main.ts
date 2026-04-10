import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { getSetupStatus, downloadCli, installCore, compileSketch } from './arduinoCli';
import { streamChat, ChatMessage, CircuitContextMode } from './claudeChat';
import path from 'path';
import fs from 'fs';
import os from 'os';

const isDev = !app.isPackaged;

// ---- Config & Data Paths ---- //

const CONFIG_FILE = path.join(app.getPath('userData'), 'e101-config.json');

/**
 * Persistent app config. The Anthropic API key lives here in the userData
 * directory and never leaves the main process — the renderer can ask whether
 * a key is configured (boolean) but never sees the value itself.
 */
interface AppConfig {
  dataFilePath: string;
  apiKey?: string;
  chatModel?: string;
  sidebarWidth?: number;
  circuitContextMode?: CircuitContextMode;
}

function getOneDrivePath(): string | null {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const p = path.join(home, 'OneDrive', 'Documents', 'e101');
    if (fs.existsSync(path.join(home, 'OneDrive'))) return p;
  } else if (process.platform === 'darwin') {
    const p = path.join(home, 'Library', 'CloudStorage', 'OneDrive-Personal', 'e101');
    if (fs.existsSync(path.join(home, 'Library', 'CloudStorage', 'OneDrive-Personal'))) return p;
  }
  return null;
}

function getDefaultDataDir(): string {
  const oneDrive = getOneDrivePath();
  if (oneDrive) return oneDrive;
  return app.getPath('userData');
}

function loadConfig(): AppConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch {
    // Ignore corrupt config
  }
  return { dataFilePath: path.join(getDefaultDataDir(), 'e101.json') };
}

function saveConfig(config: AppConfig) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---- Circuits Directory ---- //

function getCircuitsDir(): string {
  const config = loadConfig();
  const dir = path.join(path.dirname(config.dataFilePath), 'circuits');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

const ECX_FILTER = { name: 'E101 Circuit', extensions: ['ecx'] };

// ---- IPC Handlers ---- //

ipcMain.handle('save-circuit', async (_event, data: string, currentPath?: string) => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return null;

  const dir = getCircuitsDir();
  ensureDir(path.join(dir, 'dummy'));

  const result = await dialog.showSaveDialog(win, {
    title: 'Save Circuit',
    defaultPath: currentPath || path.join(dir, 'untitled.ecx'),
    filters: [ECX_FILTER],
  });

  if (result.canceled || !result.filePath) return null;

  fs.writeFileSync(result.filePath, data, 'utf-8');
  const name = path.basename(result.filePath, '.ecx');
  return { filePath: result.filePath, name };
});

ipcMain.handle('load-circuit', async () => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return null;

  const dir = getCircuitsDir();

  const result = await dialog.showOpenDialog(win, {
    title: 'Open Circuit',
    defaultPath: dir,
    filters: [ECX_FILTER],
    properties: ['openFile'],
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  const filePath = result.filePaths[0];
  const data = fs.readFileSync(filePath, 'utf-8');
  const name = path.basename(filePath, '.ecx');
  return { filePath, name, data };
});

ipcMain.handle('get-config', () => {
  // Strip the API key before sending the config to the renderer — the
  // renderer only needs to know whether one is configured, not its value.
  const cfg = loadConfig();
  const { apiKey, ...safe } = cfg;
  return { ...safe, hasApiKey: !!apiKey };
});

// ---- Claude Chat config ---- //
//
// The API key never leaves the main process. The renderer can set/clear it
// and check whether one is configured, but cannot read it back.

ipcMain.handle('chat-set-api-key', (_event, apiKey: string) => {
  const cfg = loadConfig();
  cfg.apiKey = apiKey.trim() || undefined;
  saveConfig(cfg);
  return { hasApiKey: !!cfg.apiKey };
});

ipcMain.handle('chat-clear-api-key', () => {
  const cfg = loadConfig();
  delete cfg.apiKey;
  saveConfig(cfg);
  return { hasApiKey: false };
});

ipcMain.handle('chat-set-model', (_event, model: string) => {
  const cfg = loadConfig();
  cfg.chatModel = model;
  saveConfig(cfg);
  return cfg.chatModel;
});

ipcMain.handle('chat-set-circuit-mode', (_event, mode: CircuitContextMode) => {
  const cfg = loadConfig();
  cfg.circuitContextMode = mode;
  saveConfig(cfg);
  return cfg.circuitContextMode;
});

ipcMain.handle('chat-set-sidebar-width', (_event, width: number) => {
  const cfg = loadConfig();
  cfg.sidebarWidth = Math.max(240, Math.min(720, Math.round(width)));
  saveConfig(cfg);
  return cfg.sidebarWidth;
});

// Streaming chat send. We don't return the result through invoke — instead
// the main process pumps token deltas back via webContents.send so the
// renderer can render them as they arrive. This handler resolves
// immediately with an ack; completion is signalled via chat-stream-done.
ipcMain.handle(
  'chat-send',
  async (
    event,
    payload: {
      requestId: string;
      messages: ChatMessage[];
      circuitContext: string;
      componentCatalog: string;
    },
  ) => {
    const cfg = loadConfig();
    if (!cfg.apiKey) {
      event.sender.send('chat-stream-error', {
        requestId: payload.requestId,
        kind: 'no_key',
        message: 'No Anthropic API key configured. Add one in Settings.',
      });
      return { started: false };
    }
    // Fire and forget — streamChat handles its own errors and pushes them
    // back over IPC. Awaiting it here would block the invoke return, which
    // we want to ack quickly so the UI can mark the request in-flight.
    void streamChat(event.sender, {
      apiKey: cfg.apiKey,
      model: cfg.chatModel || 'claude-opus-4-6',
      messages: payload.messages,
      circuitContext: payload.circuitContext,
      componentCatalog: payload.componentCatalog,
      requestId: payload.requestId,
    });
    return { started: true };
  },
);

// Save a named circuit to the circuits folder (used for bootstrapping demos)
ipcMain.handle('save-demo', async (_event, name: string, data: string) => {
  const dir = getCircuitsDir();
  const filePath = path.join(dir, `${name}.ecx`);
  fs.writeFileSync(filePath, data, 'utf-8');
  return filePath;
});

// Load a named circuit from the circuits folder
ipcMain.handle('load-named-circuit', async (_event, name: string) => {
  const dir = getCircuitsDir();
  const filePath = path.join(dir, `${name}.ecx`);
  if (!fs.existsSync(filePath)) return null;
  const data = fs.readFileSync(filePath, 'utf-8');
  return { filePath, name, data };
});

ipcMain.handle('get-version', () => {
  return app.getVersion();
});

ipcMain.on('set-title', (_event, title: string) => {
  const win = BrowserWindow.getFocusedWindow();
  if (win) win.setTitle(title);
});

// ---- Arduino CLI ---- //

ipcMain.handle('arduino-status', () => {
  return getSetupStatus();
});

ipcMain.handle('arduino-setup', async () => {
  try {
    const status = getSetupStatus();
    const messages: string[] = [];
    if (!status.cliInstalled) {
      const msg = await downloadCli();
      messages.push(msg);
    }
    if (!status.coreInstalled) {
      const msg = await installCore();
      messages.push(msg);
    }
    return { success: true, messages };
  } catch (err: unknown) {
    const e = err as { message?: string; stderr?: string };
    const detail = e.stderr || e.message || 'Unknown error during setup';
    return { success: false, error: detail };
  }
});

ipcMain.handle('arduino-compile', async (_event, sketchCode: string) => {
  try {
    const result = await compileSketch(sketchCode);
    return { success: true, hex: result.hex, output: result.output };
  } catch (err: unknown) {
    const e = err as { message?: string };
    return { success: false, error: e.message || 'Compilation failed' };
  }
});

// Open a native file picker for an .ino file. Returns the absolute path so
// the renderer can later write the compiled .hex next to it.
ipcMain.handle('arduino-open-sketch', async () => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    title: 'Open Arduino Sketch',
    filters: [{ name: 'Arduino Sketch', extensions: ['ino'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const data = fs.readFileSync(filePath, 'utf-8');
  return { filePath, name: path.basename(filePath), data };
});

// Write a compiled hex string next to the source .ino — used to cache the
// hex on disk so the user can later load it directly via "Load .hex" without
// re-running the sketch editor compile flow.
ipcMain.handle('arduino-save-hex', async (_event, sketchFilePath: string, hexContent: string) => {
  try {
    const dir = path.dirname(sketchFilePath);
    const base = path.basename(sketchFilePath, path.extname(sketchFilePath));
    const hexPath = path.join(dir, `${base}.hex`);
    fs.writeFileSync(hexPath, hexContent, 'utf-8');
    return { success: true, hexPath };
  } catch (err: unknown) {
    const e = err as { message?: string };
    return { success: false, error: e.message || 'Failed to save hex' };
  }
});

// ---- Chip Definitions ---- //

function getChipsDir(): string {
  const config = loadConfig();
  return path.join(path.dirname(config.dataFilePath), 'chips');
}

ipcMain.handle('load-hex', async () => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    title: 'Load AVR Hex File',
    filters: [{ name: 'Intel HEX', extensions: ['hex'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const data = fs.readFileSync(filePath, 'utf-8');
  const name = path.basename(filePath);
  return { filePath, name, data };
});

ipcMain.handle('load-chips', async () => {
  const dir = getChipsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    return [];
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const chips: unknown[] = [];
  for (const file of files) {
    try {
      const data = fs.readFileSync(path.join(dir, file), 'utf-8');
      const parsed = JSON.parse(data);
      if (parsed.type && parsed.pins) {
        chips.push(parsed);
      }
    } catch {
      // Skip invalid files
    }
  }
  return chips;
});

// Save a chip definition JSON to the chips directory (used by AI create_component_type)
ipcMain.handle('save-chip', async (_event, chipJson: unknown) => {
  const dir = getChipsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const chip = chipJson as { type: string };
  const filePath = path.join(dir, `${chip.type}.json`);
  fs.writeFileSync(filePath, JSON.stringify(chipJson, null, 2), 'utf-8');
  return filePath;
});

// ---- Autosave ---- //

function getAutosavePath(): string {
  const config = loadConfig();
  return path.join(path.dirname(config.dataFilePath), 'autosave.ecx');
}

ipcMain.handle('autosave', async (_event, data: string) => {
  const filePath = getAutosavePath();
  ensureDir(filePath);
  fs.writeFileSync(filePath, data, 'utf-8');
  return filePath;
});

ipcMain.handle('load-autosave', async () => {
  const filePath = getAutosavePath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    return { data };
  } catch {
    return null;
  }
});

// ---- Window ---- //

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5174');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../index.html'));
  }

  // Application menu
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Save\tCtrl+S', click: () => mainWindow.webContents.send('menu-action', 'save') },
        { label: 'Open\tCtrl+O', click: () => mainWindow.webContents.send('menu-action', 'open') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo\tCtrl+Z', click: () => mainWindow.webContents.send('menu-action', 'undo') },
        { label: 'Redo\tCtrl+Shift+Z', click: () => mainWindow.webContents.send('menu-action', 'redo') },
        { type: 'separator' },
        { label: 'Copy\tCtrl+C', click: () => mainWindow.webContents.send('menu-action', 'copy') },
        { label: 'Paste\tCtrl+V', click: () => mainWindow.webContents.send('menu-action', 'paste') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Developer Tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => mainWindow.webContents.toggleDevTools() },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'About E101', click: () => mainWindow.webContents.send('menu-action', 'about') },
        { label: 'Settings', click: () => mainWindow.webContents.send('menu-action', 'settings') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
