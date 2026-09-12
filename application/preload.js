const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Window chrome
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),

  // Footage sources / camera discovery
  getSources: () => ipcRenderer.invoke('get-sources'),
  listCameras: (sourceKey) => ipcRenderer.invoke('list-cameras', sourceKey),

  // Footage Upload section
  uploadFootage: (sourceKey) => ipcRenderer.invoke('upload-footage', sourceKey),
  removeFootage: (sourceKey, fileName) => ipcRenderer.invoke('remove-footage', sourceKey, fileName),

  // Telemetry stream
  startTelemetry: () => ipcRenderer.send('telemetry-start'),
  stopTelemetry: () => ipcRenderer.send('telemetry-stop'),
  onTelemetryEvent: (callback) => {
    ipcRenderer.on('telemetry-event', (_event, payload) => callback(payload));
  },
});