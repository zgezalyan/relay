const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('relay', {
  load: () => ipcRenderer.invoke('workspace:load'),
  save: (data) => ipcRenderer.invoke('workspace:save', data),
  saveSync: (data) => ipcRenderer.sendSync('workspace:saveSync', data),
  exportWorkspace: (text) => ipcRenderer.invoke('workspace:export', text),
  importWorkspace: () => ipcRenderer.invoke('workspace:import'),
  send: (payload) => ipcRenderer.invoke('request:send', payload),
  cancel: (requestId) => ipcRenderer.invoke('request:cancel', requestId),
  pickFile: () => ipcRenderer.invoke('dialog:pickFile'),
  saveFile: (payload) => ipcRenderer.invoke('file:save', payload),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
});
