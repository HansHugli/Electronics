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
  onMenuAction: (callback: (action: string) => void) => {
    ipcRenderer.removeAllListeners('menu-action');
    ipcRenderer.on('menu-action', (_event, action: string) => callback(action));
  },
});
