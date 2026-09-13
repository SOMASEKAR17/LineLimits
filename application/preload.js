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

  // Pipeline runner
  runPipeline: () => ipcRenderer.invoke('run-pipeline'),
  stopPipeline: () => ipcRenderer.invoke('stop-pipeline'),
  getPipelineStatus: () => ipcRenderer.invoke('get-pipeline-status'),

  // Violations + ground truth
  loadViolations: () => ipcRenderer.invoke('load-violations'),
  getGroundTruthWindows: () => ipcRenderer.invoke('get-ground-truth-windows'),
  getFlaggedClips: () => ipcRenderer.invoke('get-flagged-clips'),
  getSourceVideoPath: (cameraId) => ipcRenderer.invoke('get-source-video-path', cameraId),

  // Car identification (transponder-loop correlation)
  identifyCar: (camera, startFrame, endFrame) =>
    ipcRenderer.invoke('identify-car', camera, startFrame, endFrame),
  getEntryList: () => ipcRenderer.invoke('get-entry-list'),

  // Events from main process
  onTelemetryEvent: (callback) => {
    ipcRenderer.on('telemetry-event', (_event, payload) => callback(payload));
  },
  onPipelineStatus: (callback) => {
    ipcRenderer.on('pipeline-status', (_event, payload) => callback(payload));
  },
  onPipelineViolation: (callback) => {
    ipcRenderer.on('pipeline-violation', (_event, payload) => callback(payload));
  },
});