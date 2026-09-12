const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const config = require('./config.json');

let mainWindow = null;
let telemetryTimer = null;
let activeCameras = [];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    backgroundColor: '#F8F9FA',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopMockTelemetry();
  });
}

app.whenReady().then(() => {
  createWindow();
  // Telemetry is mocked and independent of which screen is focused, so it
  // can start as soon as the window exists instead of waiting on a
  // "choose a source" screen that no longer exists in the 4-section UI.
  startMockTelemetry();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ------------------------------------------------------------------
// Custom titlebar controls (frameless window)
// ------------------------------------------------------------------

ipcMain.on('window-minimize', () => mainWindow && mainWindow.minimize());

ipcMain.on('window-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

ipcMain.on('window-close', () => mainWindow && mainWindow.close());

// ------------------------------------------------------------------
// Footage sources (Live source toggle + Footage Upload section)
// ------------------------------------------------------------------

ipcMain.handle('get-sources', () => config.sources);

// ------------------------------------------------------------------
// Camera discovery
// ------------------------------------------------------------------

function discoverCameras(sourceKey) {
  const source = config.sources[sourceKey];
  if (!source) throw new Error(`Unknown footage source: ${sourceKey}`);

  const dir = path.resolve(__dirname, source.dir);
  if (!fs.existsSync(dir)) {
    return { dir, exists: false, cameras: [] };
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => config.videoExtensions.includes(path.extname(f).toLowerCase()))
    .sort();

  const cameras = files.map((file, index) => {
    const match = file.match(/cam[-_ ]?(\d+)/i);
    const camNumber = match ? parseInt(match[1], 10) : index + 1;
    return {
      id: `CAM${camNumber}`,
      camNumber,
      fileName: file,
      filePath: `file://${path.join(dir, file).replace(/\\/g, '/')}`,
    };
  });

  cameras.sort((a, b) => a.camNumber - b.camNumber);

  return { dir, exists: true, cameras };
}

ipcMain.handle('list-cameras', (event, sourceKey) => {
  const result = discoverCameras(sourceKey);
  activeCameras = result.cameras;
  return result;
});

// ------------------------------------------------------------------
// Footage Upload — copy files chosen from a native dialog into the
// selected footage folder, then re-scan it.
// ------------------------------------------------------------------

ipcMain.handle('upload-footage', async (event, sourceKey) => {
  const source = config.sources[sourceKey];
  if (!source) throw new Error(`Unknown footage source: ${sourceKey}`);

  const dir = path.resolve(__dirname, source.dir);
  fs.mkdirSync(dir, { recursive: true });

  const extensionFilters = config.videoExtensions.map((ext) => ext.replace('.', ''));
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: `Add clips to ${source.label}`,
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video files', extensions: extensionFilters }],
  });

  if (picked.canceled || picked.filePaths.length === 0) {
    const current = discoverCameras(sourceKey);
    activeCameras = current.cameras;
    return { added: 0, ...current };
  }

  let added = 0;
  for (const srcPath of picked.filePaths) {
    const destPath = path.join(dir, path.basename(srcPath));
    fs.copyFileSync(srcPath, destPath);
    added += 1;
  }

  const result = discoverCameras(sourceKey);
  activeCameras = result.cameras;
  return { added, ...result };
});

ipcMain.handle('remove-footage', (event, sourceKey, fileName) => {
  const source = config.sources[sourceKey];
  if (!source) throw new Error(`Unknown footage source: ${sourceKey}`);

  const dir = path.resolve(__dirname, source.dir);
  const targetPath = path.join(dir, fileName);

  if (path.dirname(targetPath) !== dir) {
    throw new Error('Invalid file name');
  }

  if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);

  const result = discoverCameras(sourceKey);
  activeCameras = result.cameras;
  return result;
});

// ------------------------------------------------------------------
// Telemetry bridge (mock)
// ------------------------------------------------------------------

const EVENT_TYPES = [
  { type: 'tier1_clear', weight: 55 },
  { type: 'tier1_car_detected', weight: 20 },
  { type: 'tier2_processing', weight: 15 },
  { type: 'violation_confirmed', weight: 10 },
];

function pickEventType() {
  const total = EVENT_TYPES.reduce((sum, e) => sum + e.weight, 0);
  let roll = Math.random() * total;
  for (const entry of EVENT_TYPES) {
    if (roll < entry.weight) return entry.type;
    roll -= entry.weight;
  }
  return EVENT_TYPES[0].type;
}

function generateMockEvent() {
  if (activeCameras.length === 0) return null;
  const camera = activeCameras[Math.floor(Math.random() * activeCameras.length)];
  const type = pickEventType();
  const frame = Math.floor(Math.random() * 3600);

  return {
    camera: camera.id,
    type,
    frame,
    timestamp: new Date().toISOString(),
    frameRange: type === 'violation_confirmed' ? [Math.max(0, frame - 100), frame + 200] : null,
  };
}

function startMockTelemetry() {
  if (!config.mockTelemetry || telemetryTimer) return;
  telemetryTimer = setInterval(() => {
    if (!mainWindow) return;
    const event = generateMockEvent();
    if (event) mainWindow.webContents.send('telemetry-event', event);
  }, 1800);
}

function stopMockTelemetry() {
  if (telemetryTimer) {
    clearInterval(telemetryTimer);
    telemetryTimer = null;
  }
}

ipcMain.on('telemetry-start', startMockTelemetry);
ipcMain.on('telemetry-stop', stopMockTelemetry);