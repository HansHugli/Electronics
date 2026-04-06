import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';

const isDev = !app.isPackaged;

// ---- Config & Data Paths ---- //

const CONFIG_FILE = path.join(app.getPath('userData'), 'e101-config.json');

interface AppConfig {
  dataFilePath: string;
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
  return path.dirname(config.dataFilePath);
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
  return loadConfig();
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

  // Open devtools with Ctrl+Shift+I (not by default)
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.control && input.shift && input.key === 'I') {
      mainWindow.webContents.toggleDevTools();
    }
  });
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
