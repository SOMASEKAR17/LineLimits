const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const readline = require('readline');
const { pathToFileURL } = require('url');

const config = require('./config.json');
const { CarIdentifier } = require('./carIdentifier');

let mainWindow = null;
let pipelineProcess = null;
let violationsWatcher = null;
let lastViolationsSize = 0;

const PROJECT_ROOT = path.resolve(__dirname, '..');
const VIOLATIONS_FILE = path.join(PROJECT_ROOT, 'pipeline', 'violations.jsonl');
const VENV_PYTHON = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe');

// Transponder-loop correlation — resolves which car is in a violation window.
const carIdentifier = new CarIdentifier(path.join(PROJECT_ROOT, 'pipeline'));

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
    stopPipeline();
    stopViolationsWatcher();
  });
}

app.whenReady().then(() => {
  createWindow();
  // Start watching violations.jsonl for any results the pipeline
  // may have already written (or writes while the app is open).
  startViolationsWatcher();
});

app.on('window-all-closed', () => {
  stopPipeline();
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
    return { added: 0, ...current };
  }

  let added = 0;
  for (const srcPath of picked.filePaths) {
    const destPath = path.join(dir, path.basename(srcPath));
    fs.copyFileSync(srcPath, destPath);
    added += 1;
  }

  const result = discoverCameras(sourceKey);
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
  return result;
});

// ------------------------------------------------------------------
// Pipeline runner — spawn/stop the Python pipeline as a child process
// ------------------------------------------------------------------

ipcMain.handle('run-pipeline', () => {
  if (pipelineProcess) {
    return { status: 'already_running' };
  }

  // Clear previous violations file so the dashboard starts fresh
  try { fs.unlinkSync(VIOLATIONS_FILE); } catch { /* ok if missing */ }
  lastViolationsSize = 0;

  // Clear previous flagged clips
  const flaggedDir = path.join(PROJECT_ROOT, 'flagged');
  try {
    if (fs.existsSync(flaggedDir)) {
      fs.rmSync(flaggedDir, { recursive: true, force: true });
    }
  } catch { /* ok */ }

  const pythonPath = fs.existsSync(VENV_PYTHON)
    ? VENV_PYTHON
    : 'python';

  pipelineProcess = spawn(pythonPath, ['-m', 'pipeline.orchestrator'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  console.log(`[Pipeline] Started (pid=${pipelineProcess.pid})`);
  sendToRenderer('pipeline-status', { running: true, pid: pipelineProcess.pid });

  // Stream stdout line-by-line as telemetry events
  const rl = readline.createInterface({ input: pipelineProcess.stdout });
  rl.on('line', (line) => {
    console.log(`[Pipeline] ${line}`);
    const event = parsePipelineLine(line);
    if (event) sendToRenderer('telemetry-event', event);
  });

  pipelineProcess.stderr.on('data', (chunk) => {
    // Ray and YOLO print INFO to stderr — just log it
    const text = chunk.toString().trim();
    if (text) console.log(`[Pipeline/stderr] ${text}`);
  });

  pipelineProcess.on('close', (code) => {
    console.log(`[Pipeline] Exited with code ${code}`);
    pipelineProcess = null;
    sendToRenderer('pipeline-status', { running: false, exitCode: code });
  });

  return { status: 'started', pid: pipelineProcess.pid };
});

ipcMain.handle('stop-pipeline', () => {
  stopPipeline();
  return { status: 'stopped' };
});

ipcMain.handle('get-pipeline-status', () => {
  return { running: !!pipelineProcess };
});

function stopPipeline() {
  if (pipelineProcess) {
    try {
      pipelineProcess.kill('SIGTERM');
    } catch { /* already dead */ }
    pipelineProcess = null;
    sendToRenderer('pipeline-status', { running: false });
  }
}

/**
 * Parse a pipeline stdout line into a telemetry event object.
 * Returns null for lines that aren't interesting to the UI.
 */
function parsePipelineLine(line) {
  const timestamp = new Date().toISOString();

  // "[CAM3] Locking clip: frames 0-283 -> Tier 2 (GPU)"
  let m = line.match(/\[(CAM\d+)\] Locking clip: frames (\d+)-(\d+)/);
  if (m) {
    return {
      camera: m[1],
      type: 'tier2_processing',
      frame: parseInt(m[2], 10),
      frameRange: [parseInt(m[2], 10), parseInt(m[3], 10)],
      timestamp,
    };
  }

  // "[CAM3] Clip cleared, no violation confirmed."
  m = line.match(/\[(CAM\d+)\] Clip cleared/);
  if (m) {
    return { camera: m[1], type: 'tier1_clear', frame: 0, timestamp };
  }

  // "[CAM4] ✓ VERIFIED violation (matches: many violations) avg_prob=93%"
  m = line.match(/\[(CAM\d+)\] . VERIFIED violation.*avg_prob=(\d+)/);
  if (m) {
    return {
      camera: m[1],
      type: 'violation_confirmed',
      frame: 0,
      probability: parseInt(m[2], 10),
      timestamp,
    };
  }

  // "[CAM6] ✗ SUPPRESSED"
  m = line.match(/\[(CAM\d+)\] . SUPPRESSED/);
  if (m) {
    return { camera: m[1], type: 'tier1_clear', frame: 0, timestamp, suppressed: true };
  }

  // "[PoseModel] Using GPU: ..."
  if (line.includes('[PoseModel]')) {
    return { camera: 'SYSTEM', type: 'tier1_car_detected', frame: 0, timestamp, message: line };
  }

  return null;
}

// ------------------------------------------------------------------
// Violations file watcher — reads new lines from violations.jsonl
// and sends verified violations to the renderer as incidents.
// ------------------------------------------------------------------

function startViolationsWatcher() {
  // Read any existing violations first
  readNewViolations();

  // Watch for changes
  const dir = path.dirname(VIOLATIONS_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch { /* ok */ }

  try {
    violationsWatcher = fs.watch(dir, (eventType, filename) => {
      if (filename === 'violations.jsonl') {
        readNewViolations();
      }
    });
  } catch (err) {
    console.error('[ViolationsWatcher] Could not watch directory:', err.message);
  }
}

function stopViolationsWatcher() {
  if (violationsWatcher) {
    violationsWatcher.close();
    violationsWatcher = null;
  }
}

function readNewViolations() {
  if (!fs.existsSync(VIOLATIONS_FILE)) return;

  const stat = fs.statSync(VIOLATIONS_FILE);
  if (stat.size <= lastViolationsSize) return;

  const content = fs.readFileSync(VIOLATIONS_FILE, 'utf-8');
  const lines = content.trim().split('\n');
  lastViolationsSize = stat.size;

  for (const line of lines) {
    try {
      const violation = JSON.parse(line);
      // Only send verified violations to the renderer
      if (violation.verified === true) {
        sendToRenderer('pipeline-violation', withCarIdentity(violation));
      }
    } catch { /* skip malformed lines */ }
  }
}

// ------------------------------------------------------------------
// Car identification — transponder-loop correlation
//
// The pipeline already stamps `car` onto every violation it confirms
// (see pipeline/alert_producer.py). Anything that reaches the dashboard
// without one — an older violations.jsonl line, a ground-truth window,
// a manual steward flag — gets resolved here against the same feed.
// ------------------------------------------------------------------

function withCarIdentity(violation) {
  if (violation.car) return violation;
  const car = carIdentifier.identify(
    violation.camera,
    violation.clip_start_frame,
    violation.clip_end_frame,
  );
  return car ? { ...violation, car } : violation;
}

ipcMain.handle('identify-car', (event, camera, startFrame, endFrame) => {
  try {
    return carIdentifier.identify(camera, startFrame, endFrame);
  } catch (err) {
    console.error('[carIdentifier]', err.message);
    return null;
  }
});

ipcMain.handle('get-entry-list', () => {
  return [...carIdentifier.entries.values()];
});

// ------------------------------------------------------------------
// Load existing violations on demand (renderer requests at boot)
// ------------------------------------------------------------------

ipcMain.handle('load-violations', () => {
  if (!fs.existsSync(VIOLATIONS_FILE)) return [];

  const content = fs.readFileSync(VIOLATIONS_FILE, 'utf-8');
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((v) => v && v.verified === true)
    .map(withCarIdentity);
});

// ------------------------------------------------------------------
// Ground-truth violation windows (from footage-mappings.txt)
// ------------------------------------------------------------------

const FOOTAGE_MAPPINGS_FILE = path.join(PROJECT_ROOT, 'footage-mappings.txt');
const ASSUMED_FPS = 30;

function parseTimestamp(ts) {
  const parts = ts.trim().split(':').map(Number);
  if (parts.length === 3) {
    return parts[0] * 60 * ASSUMED_FPS + parts[1] * ASSUMED_FPS + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * ASSUMED_FPS + parts[1];
  }
  return 0;
}

function parseFootageMappings() {
  if (!fs.existsSync(FOOTAGE_MAPPINGS_FILE)) return {};

  const text = fs.readFileSync(FOOTAGE_MAPPINGS_FILE, 'utf-8');
  const result = {};
  for (let i = 1; i <= 8; i++) result[`CAM${i}`] = [];

  for (const line of text.split('\n')) {
    const m = line.match(/CAM[-_ ]?(\d+)\s*:\s*(.*)/i);
    if (!m) continue;

    const camera = `CAM${m[1]}`;
    const desc = m[2];

    if (/entire\s+video\s+no\s+violation/i.test(desc)) continue;

    // Split on commas before "car detect"
    const segments = desc.split(/,\s*(?=car\s+detect)/i);
    for (const seg of segments) {
      const timeMatch = seg.match(/(?:at\s+)?(\d+:\d+(?::\d+)?)\s+to\s+(\d+:\d+(?::\d+)?)/);
      if (!timeMatch) continue;

      const start = parseTimestamp(timeMatch[1]);
      const end = parseTimestamp(timeMatch[2]);

      // Check if this segment mentions a violation
      const afterTime = seg.slice(timeMatch.index + timeMatch[0].length);
      const hasViolation = /\d+\s+violation|many\s+violation|\(\d+\s+violation|maybe.*violation/i.test(afterTime) ||
                           /\d+\s+violation|many\s+violation|\(\d+\s+violation|maybe.*violation/i.test(seg);
      const isNoViolation = /\bno\s+violation/i.test(afterTime) && !/maybe/i.test(afterTime);

      if (hasViolation && !isNoViolation) {
        const labelMatch = seg.match(/(\d+\s+violations?|many\s+violations?)/i);
        const label = labelMatch ? labelMatch[1] : (seg.includes('maybe') ? 'maybe low-prob' : 'violation');
        result[camera].push({ start, end, label });
      }
    }
  }

  return result;
}

ipcMain.handle('get-ground-truth-windows', () => {
  return parseFootageMappings();
});

// ------------------------------------------------------------------
// Flagged clips listing (both annotated and raw versions)
// ------------------------------------------------------------------

const FLAGGED_DIR = path.join(PROJECT_ROOT, 'flagged');
const FLAG_TEST_DIR = path.join(PROJECT_ROOT, 'flag_test');

ipcMain.handle('get-flagged-clips', () => {
  const clips = [];

  // Helper: scan a directory and collect annotated clips
  function scanDir(dir) {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mp4'));

    for (const file of files) {
      if (file.includes('_raw')) continue;

      const baseName = file.replace('.mp4', '');
      const rawFile = `${baseName}_raw.mp4`;
      const hasRaw = files.includes(rawFile);

      let rawPath = hasRaw ? pathToFileURL(path.join(dir, rawFile)).href : null;
      let rawIsSource = false;

      // If no raw clip exists, use the source simulation video as raw
      if (!rawPath) {
        const camMatch = baseName.match(/CAM(\d+)/i);
        if (camMatch) {
          const simDir = path.resolve(__dirname, config.sources.simulation.dir);
          const srcFile = path.join(simDir, `CAM-${camMatch[1]}.mp4`);
          if (fs.existsSync(srcFile)) {
            rawPath = `file://${srcFile.replace(/\\/g, '/')}`;
            rawIsSource = true;
          }
        }
      }

      clips.push({
        baseName,
        annotatedPath: pathToFileURL(path.join(dir, file)).href,
        rawPath,
        rawIsSource,
      });
    }
  }

  scanDir(FLAGGED_DIR);
  scanDir(FLAG_TEST_DIR);

  return clips;
});

ipcMain.handle('get-source-video-path', (event, cameraId) => {
  // Return the file:// path to the source simulation footage for a camera
  const simDir = path.resolve(__dirname, config.sources.simulation.dir);
  const camNum = cameraId.replace('CAM', '');
  const filename = `CAM-${camNum}.mp4`;
  const fullPath = path.join(simDir, filename);
  if (!fs.existsSync(fullPath)) return null;
  return `file://${fullPath.replace(/\\/g, '/')}`;
});

// ------------------------------------------------------------------
// Helper
// ------------------------------------------------------------------

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}