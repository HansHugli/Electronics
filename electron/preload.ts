import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronApi', {
  appName: 'E101 Electronics Simulator',
  saveCircuit: (data: string, currentPath?: string) => ipcRenderer.invoke('save-circuit', data, currentPath),
  loadCircuit: () => ipcRenderer.invoke('load-circuit'),
  getConfig: () => ipcRenderer.invoke('get-config'),
});
