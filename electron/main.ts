import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, session, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';

import { getSetupStatus, downloadCli, installCore, compileSketch } from './arduinoCli';
import { cancelChat, ChatMessage, runChat } from './claudeChat';
import { closeOpenToolUse, ConversationStore, historyFromPlain, userTurn } from './chatHistory';
import { AppConfig, CircuitContextMode, ConfigStore } from './config';
import { autosaveFileName, defaultDataDir, LEGACY_AUTOSAVE_NAME } from './dataPaths';
import {
  atomicWriteFileSync,
  friendlyFsError,
  isValidCircuitName,
  isValidTypeId,
  resolveInside,
} from './fsSafe';
import { chooseModel, ModelChoice, normaliseModelSetting } from './modelSelect';
import { calculateCost, pricingTable } from './pricing';
import { keyStorageOf, migratePlaintextKey, readApiKey, writeApiKey } from './secrets';
import { DEV_SERVER_URL, isAppUrl, isSafeExternalUrl } from './security';
import { UsageRecord, UsageStore } from './usageStore';

// ---- Test isolation ---- //
// E101_USER_DATA points userData (config, usage, tools) at a scratch folder.
// It also turns off OneDrive detection, so a test run never touches the real
// data folder. Must run before anything reads app.getPath('userData').
const TEST_USER_DATA = process.env.E101_USER_DATA;
if (TEST_USER_DATA) app.setPath('userData', path.resolve(TEST_USER_DATA));

// E101_PROD=1 loads the built page from dist/ without packaging (for tests).
const isDev = !app.isPackaged && process.env.E101_PROD !== '1';
const INDEX_FILE = path.join(__dirname, '../index.html');
const ORIGIN = { isDev, indexFile: INDEX_FILE };

// ---- Single instance (D4) ---- //

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

// ---- Config & data paths ---- //

const USER_DATA = app.getPath('userData');
const CONFIG_FILE = path.join(USER_DATA, 'e101-config.json');

function makeDefaultConfig(): AppConfig {
  const dir = TEST_USER_DATA
    ? USER_DATA
    : defaultDataDir(process.env, os.homedir(), process.platform, {
        exists: (p) => fs.existsSync(p),
        list: (p) => {
          try { return fs.readdirSync(p); } catch { return []; }
        },
      }, USER_DATA);
  return { dataFilePath: path.join(dir, 'e101.json') };
}

const configStore = new ConfigStore(CONFIG_FILE, makeDefaultConfig);

// First run: create the data folder and record it in the config (D5).
if (configStore.firstRun) {
  const cfg = configStore.get();
  try { fs.mkdirSync(path.dirname(cfg.dataFilePath), { recursive: true }); } catch { /* reported below */ }
  configStore.update(() => { /* writes the resolved path */ });
}

function loadConfig(): AppConfig {
  return configStore.get();
}

/**
 * The folder data is read from and written to. When the configured folder
 * is missing (OneDrive unlinked, a drive not mounted) the app uses userData
 * and says so, instead of silently switching.
 */
function dataDirStatus(): { dataDir: string; ok: boolean; problem?: string } {
  const configured = path.dirname(loadConfig().dataFilePath);
  const problems: string[] = [];
  let dataDir = configured;
  if (!fs.existsSync(configured)) {
    dataDir = USER_DATA;
    problems.push(`Your data folder ${configured} is missing; using the app folder (${USER_DATA}) until it is back.`);
  }
  if (configStore.problem) problems.push(configStore.problem);
  return { dataDir, ok: problems.length === 0, problem: problems.length ? problems.join(' ') : undefined };
}

function dataDir(): string {
  return dataDirStatus().dataDir;
}

function ensureDirOf(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getCircuitsDir(): string {
  return ensureDirOf(path.join(dataDir(), 'circuits'));
}

function getChipsDir(): string {
  return path.join(dataDir(), 'chips');
}

const ECX_FILTER = { name: 'E101 Circuit', extensions: ['ecx'] };
const MAX_CIRCUIT_BYTES = 50 * 1024 * 1024;

function requireString(value: unknown, what: string, max = MAX_CIRCUIT_BYTES): string {
  if (typeof value !== 'string') throw new Error(`The ${what} is missing.`);
  if (value.length > max) throw new Error(`The ${what} is too large.`);
  return value;
}

function readTextFile(filePath: string, max = MAX_CIRCUIT_BYTES): string {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > max) throw Object.assign(new Error('too large'), { code: 'EFBIG' });
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EFBIG') {
      throw new Error(`Could not open "${path.basename(filePath)}": the file is too large.`);
    }
    throw friendlyFsError('open', filePath, err);
  }
}

function writeTextFile(filePath: string, data: string, backup = false) {
  try {
    atomicWriteFileSync(filePath, data, { backup });
  } catch (err) {
    throw friendlyFsError('save', filePath, err);
  }
}

// ---- Usage tracking ---- //

const usageStore = new UsageStore(path.join(USER_DATA, 'e101-usage.json'));

function recordUsage(model: string, usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }, cost: number | null, rounds: number): UsageRecord {
  const entry: UsageRecord = {
    timestamp: new Date().toISOString(),
    model,
    ...usage,
    cost,
    rounds,
    pricingVersion: 2,
  };
  try {
    usageStore.append(entry);
  } catch (err) {
    console.error('Could not write the usage file:', (err as Error).message);
  }
  return entry;
}

// ---- IPC trust (S1) ---- //

function isTrustedEvent(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  const frame = event.senderFrame;
  if (!frame || frame.parent !== null) return false;
  return isAppUrl(frame.url, ORIGIN);
}

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/** ipcMain.handle that refuses calls from any page other than ours. */
function handle(channel: string, fn: Handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedEvent(event)) throw new Error('This request came from an untrusted page and was blocked.');
    return fn(event, ...args);
  });
}

function windowOf(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

// ---- Circuits ---- //

handle('save-circuit', async (event, data, currentPath) => {
  const text = requireString(data, 'circuit');
  const win = windowOf(event);
  if (!win) return null;
  const dir = getCircuitsDir();
  const result = await dialog.showSaveDialog(win, {
    title: 'Save Circuit',
    defaultPath: typeof currentPath === 'string' && currentPath ? currentPath : path.join(dir, 'untitled.ecx'),
    filters: [ECX_FILTER],
  });
  if (result.canceled || !result.filePath) return null;
  writeTextFile(result.filePath, text);
  return { filePath: result.filePath, name: path.basename(result.filePath, '.ecx') };
});

handle('load-circuit', async (event) => {
  const win = windowOf(event);
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    title: 'Open Circuit',
    defaultPath: getCircuitsDir(),
    filters: [ECX_FILTER],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const data = readTextFile(filePath);
  return { filePath, name: path.basename(filePath, '.ecx'), data };
});

// Save a named circuit to the circuits folder (used for bootstrapping demos)
handle('save-demo', async (_event, name, data) => {
  if (!isValidCircuitName(name)) throw new Error('That circuit name contains characters that are not allowed in a file name.');
  const text = requireString(data, 'circuit');
  const filePath = resolveInside(getCircuitsDir(), `${name}.ecx`);
  writeTextFile(filePath, text);
  return filePath;
});

// Load a named circuit from the circuits folder
handle('load-named-circuit', async (_event, name) => {
  if (!isValidCircuitName(name)) throw new Error('That circuit name contains characters that are not allowed in a file name.');
  const filePath = resolveInside(getCircuitsDir(), `${name}.ecx`);
  if (!fs.existsSync(filePath)) return null;
  return { filePath, name, data: readTextFile(filePath) };
});

// ---- Config ---- //

handle('get-config', () => {
  // Only safe fields: the API key (plain or encrypted) never reaches the renderer.
  const cfg = loadConfig();
  return {
    dataFilePath: cfg.dataFilePath,
    hasApiKey: keyStorageOf(cfg) !== 'none',
    keyStorage: keyStorageOf(cfg),
    chatModel: normaliseModelSetting(cfg.chatModel),
    sidebarWidth: cfg.sidebarWidth,
    circuitContextMode: cfg.circuitContextMode,
  };
});

handle('app:get-data-status', () => dataDirStatus());

handle('chat-set-api-key', (_event, apiKey) => {
  if (typeof apiKey !== 'string' || apiKey.length > 500) throw new Error('That API key is not valid.');
  const cfg = configStore.update((c) => writeApiKey(c, apiKey, safeStorage), { scrubBackup: true });
  return { hasApiKey: keyStorageOf(cfg) !== 'none' };
});

handle('chat-clear-api-key', () => {
  configStore.update((c) => writeApiKey(c, undefined, safeStorage), { scrubBackup: true });
  return { hasApiKey: false };
});

handle('chat-set-model', (_event, model) => {
  const setting = normaliseModelSetting(typeof model === 'string' ? model : undefined);
  configStore.update((c) => { c.chatModel = setting; });
  return setting;
});

handle('chat-set-circuit-mode', (_event, mode) => {
  if (mode !== 'always' && mode !== 'on-change' && mode !== 'never') throw new Error('Unknown circuit context mode.');
  configStore.update((c) => { c.circuitContextMode = mode as CircuitContextMode; });
  return mode;
});

handle('chat-set-sidebar-width', (_event, width) => {
  const w = typeof width === 'number' && Number.isFinite(width) ? width : 320;
  const cfg = configStore.update((c) => { c.sidebarWidth = Math.max(240, Math.min(720, Math.round(w))); });
  return cfg.sidebarWidth;
});

// ---- Usage ---- //

// Kept for compatibility: the chat now records usage in main itself.
handle('usage-record', (_event, record) => {
  const r = (record ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const model = typeof r.model === 'string' ? r.model.slice(0, 80) : 'unknown';
  const usage = {
    inputTokens: num(r.inputTokens),
    outputTokens: num(r.outputTokens),
    cacheReadTokens: num(r.cacheReadTokens),
    cacheWriteTokens: num(r.cacheWriteTokens),
  };
  return recordUsage(model, usage, calculateCost(model, usage), 1);
});

handle('usage-get', () => usageStore.load());

handle('usage-clear', () => {
  usageStore.clear();
  return [];
});

handle('usage-pricing', () => pricingTable());

// ---- Claude chat ---- //

const conversations = new ConversationStore();
const modelChoices = new Map<string, ModelChoice>();
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_CONTEXT_CHARS = 200_000;

handle('chat-send', async (event, rawPayload) => {
  const payload = (rawPayload ?? {}) as {
    requestId?: unknown;
    conversationId?: unknown;
    messages?: unknown;
    circuitContext?: unknown;
    componentCatalog?: unknown;
  };
  if (typeof payload.requestId !== 'string' || !REQUEST_ID_RE.test(payload.requestId)) {
    throw new Error('Invalid chat request.');
  }
  const requestId = payload.requestId;
  const messages: ChatMessage[] = Array.isArray(payload.messages)
    ? (payload.messages as ChatMessage[]).filter(
        (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
      )
    : [];
  const circuitContext = typeof payload.circuitContext === 'string' ? payload.circuitContext.slice(0, MAX_CONTEXT_CHARS) : '';
  const componentCatalog = typeof payload.componentCatalog === 'string' ? payload.componentCatalog.slice(0, MAX_CONTEXT_CHARS) : '';
  const userText = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

  const apiKey = readApiKey(loadConfig(), safeStorage);
  if (!apiKey) {
    event.sender.send('chat-stream-error', {
      requestId,
      kind: 'no_key',
      message: 'No Anthropic API key is set. Add one in Settings.',
    });
    return { started: false };
  }
  if (!userText.trim()) throw new Error('The message is empty.');

  // Main keeps each conversation's full content blocks (W4).
  const conversationId =
    typeof payload.conversationId === 'string' && REQUEST_ID_RE.test(payload.conversationId) ? payload.conversationId : null;
  let conversation;
  if (conversationId) {
    conversation = conversations.get(conversationId);
    conversation.messages = closeOpenToolUse(conversation.messages);
    conversation.messages.push(userTurn(userText, circuitContext));
  } else {
    conversation = { id: requestId, messages: historyFromPlain(messages, circuitContext), updated: Date.now() };
  }

  // One model per conversation (U3): only a dropdown change switches it.
  const key = conversationId ?? requestId;
  const choice = chooseModel(loadConfig().chatModel, modelChoices.get(key), userText);
  modelChoices.set(key, choice);

  void runChat(event.sender, {
    apiKey,
    choice,
    conversation,
    componentCatalog,
    requestId,
    onUsage: (model, usage, cost, rounds) => {
      recordUsage(model, usage, cost, rounds);
    },
    isTrustedSender: (e) => isTrustedEvent(e),
  });
  return { started: true };
});

handle('chat-cancel', (_event, requestId) => {
  return typeof requestId === 'string' ? cancelChat(requestId) : false;
});

handle('chat-reset-conversation', (_event, conversationId) => {
  if (typeof conversationId === 'string') {
    conversations.delete(conversationId);
    modelChoices.delete(conversationId);
  }
  return true;
});

handle('get-version', () => app.getVersion());

ipcMain.on('set-title', (event, title: unknown) => {
  if (!isTrustedEvent(event) || typeof title !== 'string') return;
  BrowserWindow.fromWebContents(event.sender)?.setTitle(title.slice(0, 200));
});

// ---- Arduino CLI ---- //

handle('arduino-status', () => getSetupStatus());

handle('arduino-setup', async () => {
  try {
    const status = getSetupStatus();
    const messages: string[] = [];
    if (!status.cliInstalled) messages.push(await downloadCli());
    if (!status.coreInstalled) messages.push(await installCore());
    return { success: true, messages };
  } catch (err: unknown) {
    const e = err as { message?: string; stderr?: string };
    return { success: false, error: e.stderr || e.message || 'Unknown error during setup' };
  }
});

handle('arduino-compile', async (_event, sketchCode) => {
  try {
    const result = await compileSketch(requireString(sketchCode, 'sketch', 1_000_000));
    return { success: true, hex: result.hex, output: result.output };
  } catch (err: unknown) {
    return { success: false, error: (err as Error).message || 'Compilation failed' };
  }
});

/** Sketch files the user opened through the dialog: the only places a .hex may be written next to. */
const openedSketches = new Set<string>();

handle('arduino-open-sketch', async (event) => {
  const win = windowOf(event);
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    title: 'Open Arduino Sketch',
    filters: [{ name: 'Arduino Sketch', extensions: ['ino'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const data = readTextFile(filePath, 1_000_000);
  openedSketches.add(path.resolve(filePath));
  return { filePath, name: path.basename(filePath), data };
});

const HEX_RE = /^(:[0-9A-Fa-f]{10,}\s*)+$/;

// Write a compiled hex next to an .ino the user opened in this session.
handle('arduino-save-hex', async (_event, sketchFilePath, hexContent) => {
  try {
    if (typeof sketchFilePath !== 'string' || !openedSketches.has(path.resolve(sketchFilePath))) {
      return { success: false, error: 'The .hex can only be saved next to a sketch you opened with Open Sketch.' };
    }
    const hex = requireString(hexContent, 'hex file', 4_000_000);
    if (!HEX_RE.test(hex.trim())) return { success: false, error: 'The compiled output is not a valid Intel HEX file.' };
    const resolved = path.resolve(sketchFilePath);
    const hexPath = path.join(path.dirname(resolved), `${path.basename(resolved, path.extname(resolved))}.hex`);
    writeTextFile(hexPath, hex);
    return { success: true, hexPath };
  } catch (err: unknown) {
    return { success: false, error: (err as Error).message || 'Failed to save hex' };
  }
});

handle('load-hex', async (event) => {
  const win = windowOf(event);
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    title: 'Load AVR Hex File',
    filters: [{ name: 'Intel HEX', extensions: ['hex'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  return { filePath, name: path.basename(filePath), data: readTextFile(filePath, 4_000_000) };
});

// ---- Chip definitions ---- //

handle('load-chips', async () => {
  const dir = getChipsDir();
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    return [];
  }
  const chips: unknown[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(readTextFile(path.join(dir, file), 1_000_000));
      if (parsed && typeof parsed.type === 'string' && Array.isArray(parsed.pins)) chips.push(parsed);
    } catch {
      // Skip invalid files; one bad file must not stop the others.
    }
  }
  return chips;
});

handle('delete-chip', async (_event, typeId) => {
  if (!isValidTypeId(typeId)) return { success: false, message: 'Invalid component type ID.' };
  const filePath = resolveInside(getChipsDir(), `${typeId}.json`);
  if (!fs.existsSync(filePath)) return { success: false, message: 'File not found' };
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    throw friendlyFsError('delete', filePath, err);
  }
  return { success: true };
});

handle('save-chip', async (_event, chipJson) => {
  const chip = chipJson as { type?: unknown } | null;
  if (!chip || typeof chip !== 'object' || !isValidTypeId(chip.type)) {
    throw new Error('The component type ID must be lowercase letters, digits, "_" or "-", starting with a letter.');
  }
  const text = JSON.stringify(chipJson, null, 2);
  if (text.length > 500_000) throw new Error('The component definition is too large.');
  const filePath = resolveInside(ensureDirOf(getChipsDir()), `${chip.type}.json`);
  writeTextFile(filePath, text);
  return filePath;
});

// ---- Autosave (D2, D4) ---- //

let autosaveRestored = false;

function autosavePath(): string {
  return path.join(dataDir(), autosaveFileName(os.hostname()));
}

function isEmptyCircuit(text: string): boolean {
  try {
    const c = JSON.parse(text);
    return !(c?.components?.length > 0 || c?.wires?.length > 0);
  } catch {
    return false;
  }
}

handle('autosave', async (_event, data) => {
  const text = requireString(data, 'autosave');
  const filePath = autosavePath();
  // Until the renderer has read the last session back, never replace a
  // non-empty autosave with an empty board (a slow start could wipe it).
  if (!autosaveRestored && isEmptyCircuit(text) && fs.existsSync(filePath)) {
    try {
      if (!isEmptyCircuit(fs.readFileSync(filePath, 'utf-8'))) return filePath;
    } catch { /* fall through and write */ }
  }
  ensureDirOf(path.dirname(filePath));
  writeTextFile(filePath, text, true);
  return filePath;
});

handle('load-autosave', async () => {
  const dir = dataDir();
  const candidates = [autosavePath(), path.join(dir, LEGACY_AUTOSAVE_NAME)];
  try {
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const data = readTextFile(file);
      try {
        JSON.parse(data);
        return { data };
      } catch {
        // Damaged: try its backup before giving up on this candidate.
        const bak = `${file}.bak`;
        if (fs.existsSync(bak)) {
          const backup = readTextFile(bak);
          JSON.parse(backup);
          return { data: backup };
        }
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    autosaveRestored = true;
  }
});

// ---- Window ---- //

let mainWindow: BrowserWindow | null = null;

function setupCloseGuard(win: BrowserWindow) {
  let allowClose = false;
  let ackTimer: NodeJS.Timeout | null = null;
  let acked = false;

  const reallyClose = () => {
    allowClose = true;
    if (ackTimer) clearTimeout(ackTimer);
    if (!win.isDestroyed()) win.close();
  };

  win.on('close', (e) => {
    if (allowClose) return;
    const wc = win.webContents;
    if (wc.isDestroyed() || wc.isCrashed()) return; // nothing to ask
    e.preventDefault();
    acked = false;
    wc.send('app:close-request');
    if (ackTimer) clearTimeout(ackTimer);
    // The preload answers at once when a handler is listening; if nothing
    // answers within 5 s (crashed, hung, no handler) the window closes.
    ackTimer = setTimeout(() => {
      if (!acked) reallyClose();
    }, 5000);
  });

  const onAck = (event: Electron.IpcMainEvent) => {
    if (event.sender === win.webContents && isTrustedEvent(event)) {
      acked = true;
      if (ackTimer) clearTimeout(ackTimer);
    }
  };
  const onConfirm = (event: Electron.IpcMainEvent) => {
    if (event.sender === win.webContents && isTrustedEvent(event)) reallyClose();
  };
  ipcMain.on('app:close-request-ack', onAck);
  ipcMain.on('app:confirm-close', onConfirm);
  win.on('closed', () => {
    if (ackTimer) clearTimeout(ackTimer);
    ipcMain.removeListener('app:close-request-ack', onAck);
    ipcMain.removeListener('app:confirm-close', onConfirm);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('Renderer gone:', details.reason);
    allowClose = true;
  });
}

function hardenWebContents(win: BrowserWindow) {
  const wc = win.webContents;
  // Never navigate the app window away from the app (S1).
  wc.on('will-navigate', (e, url) => {
    if (isAppUrl(url, ORIGIN)) return;
    e.preventDefault();
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
  });
  wc.on('will-redirect', (e, url) => {
    if (!isAppUrl(url, ORIGIN)) e.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  mainWindow = win;
  hardenWebContents(win);
  setupCloseGuard(win);
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (isDev) {
    void win.loadURL(DEV_SERVER_URL);
  } else {
    void win.loadFile(INDEX_FILE);
  }

  const send = (action: string) => win.webContents.send('menu-action', action);
  const isMac = process.platform === 'darwin';
  const viewMenu: Electron.MenuItemConstructorOptions[] = [
    ...(isDev
      ? [
          { label: 'Toggle Developer Tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => win.webContents.toggleDevTools() },
          { type: 'separator' as const },
        ]
      : []),
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Save\tCtrl+S', click: () => send('save') },
        { label: 'Open\tCtrl+O', click: () => send('open') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo\tCtrl+Z', click: () => send('undo') },
        { label: 'Redo\tCtrl+Shift+Z', click: () => send('redo') },
        { type: 'separator' },
        { label: 'Copy\tCtrl+C', click: () => send('copy') },
        { label: 'Paste\tCtrl+V', click: () => send('paste') },
      ],
    },
    { label: 'View', submenu: viewMenu },
    {
      label: 'Help',
      submenu: [
        { label: 'About E101', click: () => send('about') },
        { label: 'Settings', click: () => send('settings') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (gotLock) {
  app.whenReady().then(() => {
    // Encrypt a legacy plaintext API key once (S3); needs the app to be ready.
    try {
      const cfg = configStore.get();
      if (migratePlaintextKey(cfg, safeStorage)) {
        configStore.update((c) => {
          c.apiKeyEnc = cfg.apiKeyEnc;
          delete c.apiKey;
        }, { scrubBackup: true });
      }
    } catch (err) {
      console.error('API key migration failed:', (err as Error).message);
    }

    // The app needs no browser permissions (camera, notifications, ...).
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write' || permission === 'fullscreen'));

    createMainWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
