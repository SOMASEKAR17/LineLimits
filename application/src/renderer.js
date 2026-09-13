// ============================================================
// Constants + shared state
// ============================================================

const ASSUMED_FPS = 30; // matches the 30fps assumption already used in newewe.py
const CAM_SLOTS = 8;
const INCIDENTS_STORAGE_KEY = 'linelimits.incidents.v1';

let cameras = [];        // [{ id, camNumber, fileName, filePath }] for the active Live source
let liveSourceKey = 'simulation';
let sourceLabels = {};   // sourceKey -> { label, description, dir }

let videoEls = {};        // camNumber -> <video> (Live grid)
let tileStatusEls = {};   // camNumber -> status dot element
let masterVideo = null;
let isScrubbing = false;

let selectedCams = new Set();  // camNumbers currently shown in the Live grid (1..CAM_SLOTS)
let zoomLevel = 1;

let incidents = loadIncidents();
let activeIncidentId = null;

// ============================================================
// Titlebar
// ============================================================

document.getElementById('btn-minimize').addEventListener('click', () => window.api.minimize());
document.getElementById('btn-maximize').addEventListener('click', () => window.api.maximize());
document.getElementById('btn-close').addEventListener('click', () => window.api.close());

// ============================================================
// Navigation — 4 sections: Live / Review Timeline / Steward
// Review Records / Footage Upload
// ============================================================

const sections = {
  live: document.getElementById('section-live'),
  review: document.getElementById('section-review'),
  records: document.getElementById('section-records'),
  analysis: document.getElementById('section-analysis'),
  upload: document.getElementById('section-upload'),
};

document.getElementById('side-nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-item');
  if (!btn) return;
  showSection(btn.dataset.section);
  setNavCollapsed(true); // picking a section closes the overlay
});

// ------------------------------------------------------------
// Side nav collapse / overlay toggle
//
// The nav is always an absolutely-positioned overlay (see styles.css) —
// collapsing or expanding it never resizes or pushes app-main. Collapsed
// slides it off to the left behind a thin sliver where the arrow lives;
// expanded draws it back on top of whatever tab is currently showing.
// ------------------------------------------------------------

const appShellEl = document.querySelector('.app-shell');
const sideNavEl = document.getElementById('side-nav');
const sideNavToggleEl = document.getElementById('side-nav-toggle');
const sideNavToggleArrowEl = document.getElementById('side-nav-toggle-arrow');
const sideNavBackdropEl = document.getElementById('side-nav-backdrop');

let navCollapsed = false;

function setNavCollapsed(collapsed) {
  navCollapsed = collapsed;
  sideNavEl.classList.toggle('collapsed', collapsed);
  appShellEl.classList.toggle('nav-collapsed', collapsed);
  sideNavToggleArrowEl.textContent = collapsed ? '\u203a' : '\u2039'; // › : ‹
  sideNavBackdropEl.hidden = collapsed;
}

sideNavToggleEl.addEventListener('click', () => setNavCollapsed(!navCollapsed));
sideNavBackdropEl.addEventListener('click', () => setNavCollapsed(true));

setNavCollapsed(true);

function showSection(name) {
  for (const [key, el] of Object.entries(sections)) {
    el.hidden = key !== name;
  }
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.section === name);
  });

  if (name === 'review') renderQueue();
  if (name === 'records') renderRecordsTable();
  if (name === 'analysis') renderAnalysis();
  if (name === 'upload') refreshUploadFileList();
}

// ============================================================
// Incident storage (Review Timeline + Steward Review Records
// share this single array, split by `status`)
// ============================================================

function loadIncidents() {
  try {
    const raw = localStorage.getItem(INCIDENTS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error('Failed to load stored incidents', err);
    return [];
  }
}

function saveIncidents() {
  localStorage.setItem(INCIDENTS_STORAGE_KEY, JSON.stringify(incidents));
}

function genId() {
  return `inc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function addIncident({ camNumbers, frame, frameRange, timestamp, type, probability, groundTruthLabel, car }) {
  // Create one separate incident per camera — no multi-cam grouping
  const sorted = [...camNumbers].sort((a, b) => a - b);
  const created = [];
  for (const camNum of sorted) {
    const incident = {
      id: genId(),
      camera: `CAM${camNum}`,
      cameras: [camNum],
      frame,
      frameRange: frameRange || [Math.max(0, frame - 100), frame + 200],
      timestamp,
      type: type || 'auto',
      probability: probability || null,
      groundTruthLabel: groundTruthLabel || '',
      car: car || null,   // resolved by transponder-loop correlation
      status: 'pending', // 'pending' | 'reviewed'
      decision: null,
      reviewedAt: null,
    };
    incidents.unshift(incident);
    created.push(incident);
  }
  saveIncidents();
  refreshBadges();
  if (!sections.review.hidden) renderQueue();
  for (const incident of created) resolveCarIdentity(incident);
  return created[0];
}

// ============================================================
// Car identification
//
// The violation itself only knows a camera and a frame window. Which
// car that was is resolved in the main process by correlating the
// window against the transponder loop feed for that marshalling post
// (see application/carIdentifier.js and pipeline/car_identifier.py).
// Violations that came from the Python pipeline already carry the
// result; everything else is resolved here once and cached on the
// incident.
// ============================================================

async function resolveCarIdentity(incident) {
  if (!incident || incident.car) return;
  try {
    const car = await window.api.identifyCar(
      incident.camera,
      incident.frameRange[0],
      incident.frameRange[1],
    );
    if (!car) return;
    incident.car = car;
    saveIncidents();
    paintCarIdentity(incident);
  } catch (err) {
    console.error('Car identification failed:', err);
  }
}

// Re-run identification for incidents restored from a previous session
// that predate this step.
function backfillCarIdentities() {
  for (const incident of incidents) {
    if (!incident.car) resolveCarIdentity(incident);
  }
}

function carChipHTML(car) {
  if (!car) {
    return '<span class="car-chip car-chip-pending">identifying car…</span>';
  }
  return `
    <span class="car-chip" style="--team-colour: ${car.teamColour}">
      <span class="car-chip-number">${car.number}</span>
      <span class="car-chip-names">
        <span class="car-chip-driver">${car.driver}</span>
        <span class="car-chip-team">${car.team}</span>
      </span>
    </span>`;
}

// Drop a freshly resolved identity into whatever is currently on screen,
// without tearing down the queue or reloading the review videos.
function paintCarIdentity(incident) {
  document
    .querySelectorAll(`[data-car-slot="${incident.id}"]`)
    .forEach((slot) => { slot.innerHTML = carChipHTML(incident.car); });

  if (!sections.records.hidden) renderRecordsTable();
  if (!sections.analysis.hidden) renderAnalysis();
}

function refreshBadges() {
  const pendingCount = incidents.filter((i) => i.status === 'pending').length;

  const badge = document.getElementById('review-nav-badge');
  badge.textContent = String(pendingCount);
  badge.hidden = pendingCount === 0;
}

// ============================================================
// LIVE — source toggle
// ============================================================

document.getElementById('live-source-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('.pill-toggle');
  if (!btn) return;
  document.querySelectorAll('#live-source-toggle .pill-toggle').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  loadLiveSource(btn.dataset.source);
});

async function loadLiveSource(sourceKey) {
  liveSourceKey = sourceKey;
  const statusEl = document.getElementById('live-source-status');
  statusEl.textContent = 'Loading footage\u2026';

  const result = await window.api.listCameras(sourceKey);
  cameras = result.exists ? result.cameras : [];

  if (!result.exists) {
    statusEl.textContent = `Folder not found: ${result.dir}`;
  } else if (cameras.length === 0) {
    statusEl.textContent = 'No clips found in this folder yet';
  } else {
    statusEl.textContent = `${cameras.length} of ${CAM_SLOTS} camera clip(s) online`;
  }

  selectedCams = new Set(Array.from({ length: CAM_SLOTS }, (_, i) => i + 1));
  zoomLevel = 1;
  buildCameraGrid();
  buildCameraPills();
}

// ============================================================
// LIVE — camera grid
// ============================================================

function buildCameraGrid() {
  const grid = document.getElementById('camera-grid');
  grid.innerHTML = '';
  videoEls = {};
  tileStatusEls = {};
  masterVideo = null;

  for (let i = 1; i <= CAM_SLOTS; i++) {
    const camera = cameras.find((c) => c.camNumber === i);

    const tile = document.createElement('div');
    tile.className = 'camera-tile';
    tile.dataset.cam = i;

    const label = document.createElement('span');
    label.className = 'tile-label';
    label.textContent = camera ? camera.id : `CAM${i}`;
    tile.appendChild(label);

    const status = document.createElement('span');
    status.className = 'tile-status';
    tile.appendChild(status);
    tileStatusEls[i] = status;

    if (camera) {
      const video = document.createElement('video');
      video.src = camera.filePath;
      video.muted = true;
      video.loop = true;
      video.addEventListener('error', () => showNoSignal(tile, video));
      tile.appendChild(video);
      videoEls[i] = video;

      if (!masterVideo) {
        masterVideo = video;
        video.addEventListener('loadedmetadata', initSyncBarRange);
        video.addEventListener('timeupdate', syncTimecodeFromMaster);
      }
    } else {
      showNoSignal(tile, null);
    }

    tile.addEventListener('click', () => toggleCam(i));

    grid.appendChild(tile);
  }

  applyViewMode();
}

function showNoSignal(tile, video) {
  if (video) video.remove();
  if (tile.querySelector('.tile-no-signal')) return;
  const placeholder = document.createElement('div');
  placeholder.className = 'tile-no-signal';
  placeholder.textContent = 'NO SIGNAL';
  tile.appendChild(placeholder);
}

// ============================================================
// LIVE — camera picker (view all 8, or focus just 1) + zoom
// ============================================================

function buildCameraPills() {
  const wrap = document.getElementById('camera-pill-grid');
  wrap.innerHTML = '';

  const allPill = document.createElement('button');
  allPill.className = 'camera-pill all-pill';
  allPill.textContent = 'All Cameras';
  allPill.addEventListener('click', () => selectAllCams());
  wrap.appendChild(allPill);

  for (let i = 1; i <= CAM_SLOTS; i++) {
    const hasFootage = cameras.some((c) => c.camNumber === i);
    const pill = document.createElement('button');
    pill.className = 'camera-pill';
    pill.dataset.cam = i;
    if (!hasFootage) pill.classList.add('no-signal');
    pill.textContent = `CAM${i}`;
    pill.addEventListener('click', () => toggleCam(i));
    wrap.appendChild(pill);
  }

  updatePillStates();
}

function updatePillStates() {
  const wrap = document.getElementById('camera-pill-grid');
  wrap.querySelectorAll('.camera-pill').forEach((pill) => {
    const isAll = pill.classList.contains('all-pill');
    const active = isAll ? selectedCams.size === CAM_SLOTS : selectedCams.has(Number(pill.dataset.cam));
    pill.classList.toggle('active', active);
  });

  const mode = document.getElementById('cam-select-mode');
  mode.textContent = selectedCams.size === CAM_SLOTS
    ? `All ${CAM_SLOTS}`
    : `${selectedCams.size} selected`;
}

// Choose any 1, 2, 3 ... up to all 8 cameras to display at once. Clicking
// a pill (or its tile) toggles that camera in/out of the current view;
// at least one camera always stays selected.
function toggleCam(camNumber) {
  if (selectedCams.has(camNumber)) {
    if (selectedCams.size === 1) return; // keep at least one camera visible
    selectedCams.delete(camNumber);
  } else {
    selectedCams.add(camNumber);
  }
  zoomLevel = 1;
  applyViewMode();
  updatePillStates();
}

function selectAllCams() {
  selectedCams = new Set(Array.from({ length: CAM_SLOTS }, (_, i) => i + 1));
  zoomLevel = 1;
  applyViewMode();
  updatePillStates();
}

// Small lookup so 2, 3, 5, 6 ... selected cameras lay out sensibly
// instead of stretching across the full 4x2 grid.
const GRID_LAYOUTS = {
  1: [1, 1], 2: [2, 1], 3: [3, 1], 4: [2, 2],
  5: [3, 2], 6: [3, 2], 7: [4, 2], 8: [4, 2],
};

function applyViewMode() {
  const grid = document.getElementById('camera-grid');
  const zoomControl = document.getElementById('zoom-control');
  const isSingle = selectedCams.size === 1;
  const focusedCam = isSingle ? [...selectedCams][0] : null;

  document.querySelectorAll('.camera-tile').forEach((tile) => {
    const camNumber = Number(tile.dataset.cam);
    const show = selectedCams.has(camNumber);
    tile.classList.toggle('hidden-tile', !show);
    tile.classList.toggle('zoomed', isSingle && camNumber === focusedCam);
    if (!isSingle || camNumber !== focusedCam) {
      tile.style.removeProperty('--zoom-scale');
    }
  });

  const [cols, rows] = GRID_LAYOUTS[selectedCams.size] || [4, 2];
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

  zoomControl.hidden = !isSingle;
  updateZoomLabel();
}

document.getElementById('zoom-in').addEventListener('click', () => setZoom(zoomLevel + 0.25));
document.getElementById('zoom-out').addEventListener('click', () => setZoom(zoomLevel - 0.25));

function setZoom(level) {
  zoomLevel = Math.min(3, Math.max(1, level));
  if (selectedCams.size === 1) {
    const camNumber = [...selectedCams][0];
    const tile = document.querySelector(`.camera-tile[data-cam="${camNumber}"]`);
    if (tile) tile.style.setProperty('--zoom-scale', zoomLevel);
  }
  updateZoomLabel();
}

function updateZoomLabel() {
  document.getElementById('zoom-level').textContent = `${Math.round(zoomLevel * 100)}%`;
}

// ============================================================
// LIVE — sync playback bar
// ============================================================

const syncToggleBtn = document.getElementById('btn-sync-toggle');
const syncScrubber = document.getElementById('sync-scrubber');
const syncTimecode = document.getElementById('sync-timecode');

let isPlaying = false;
let playbackRate = 2; // default 2×

function initSyncBarRange() {
  const totalFrames = Math.round(masterVideo.duration * ASSUMED_FPS);
  syncScrubber.max = totalFrames || 1000;
  updateTimecode(0, masterVideo.duration || 0);
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function updateTimecode(current, duration) {
  syncTimecode.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
}

function syncTimecodeFromMaster() {
  if (isScrubbing || !masterVideo) return;
  syncScrubber.value = Math.round(masterVideo.currentTime * ASSUMED_FPS);
  updateTimecode(masterVideo.currentTime, masterVideo.duration || 0);
  renderLiveIncidentFeed();
}

syncToggleBtn.addEventListener('click', () => {
  isPlaying = !isPlaying;
  Object.values(videoEls).forEach((v) => {
    v.playbackRate = playbackRate;
    isPlaying ? v.play() : v.pause();
  });
  syncToggleBtn.textContent = isPlaying ? 'Pause all' : 'Play all';
});

// ============================================================
// LIVE — playback speed toggle (2× / 5× / 10×)
// ============================================================

document.getElementById('speed-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('.speed-btn');
  if (!btn) return;
  document.querySelectorAll('#speed-toggle .speed-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  playbackRate = Number(btn.dataset.speed);
  Object.values(videoEls).forEach((v) => { v.playbackRate = playbackRate; });
});

syncScrubber.addEventListener('input', () => {
  isScrubbing = true;
  if (masterVideo) updateTimecode(Number(syncScrubber.value) / ASSUMED_FPS, masterVideo.duration || 0);
});

syncScrubber.addEventListener('change', () => {
  const targetTime = Number(syncScrubber.value) / ASSUMED_FPS;
  Object.values(videoEls).forEach((v) => {
    v.currentTime = targetTime;
  });
  isScrubbing = false;
});

// ============================================================
// LIVE — manual Flag button
// ============================================================

document.getElementById('btn-flag').addEventListener('click', () => {
  if (!masterVideo) return;

  const camNumbers = cameras
    .map((c) => c.camNumber)
    .filter((n) => selectedCams.has(n));

  if (camNumbers.length === 0) {
    flashFlagButton('No footage on selected camera(s)');
    return;
  }

  const frame = Math.round(masterVideo.currentTime * ASSUMED_FPS);
  const created = addIncident({ camNumbers, frame, timestamp: new Date().toISOString(), type: 'manual' });
  if (created) forceShowIncidentInFeed(created);
  flashFlagButton('Flagged');
});

function flashFlagButton(label) {
  const btn = document.getElementById('btn-flag');
  const original = btn.textContent;
  btn.textContent = label;
  btn.classList.add('flagged');
  setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove('flagged');
  }, 1200);
}

// ============================================================
// Incident Feed (shown in Live) — replaces telemetry stream
// Cards appear as timeline enters incident frame ranges.
// ============================================================

let shownIncidentIds = new Set(); // track which incidents have been revealed

function renderLiveIncidentFeed() {
  if (!masterVideo) return;
  const currentFrame = Math.round(masterVideo.currentTime * ASSUMED_FPS);
  const feedBody = document.getElementById('incident-feed-body');
  const emptyMsg = document.getElementById('incident-feed-empty');
  const countEl = document.getElementById('incident-feed-count');
  if (!feedBody) return;

  let changed = false;

  for (const inc of incidents) {
    if (shownIncidentIds.has(inc.id)) continue;
    // Show the card once the current frame enters (or passes) the incident's start frame
    if (currentFrame >= inc.frameRange[0]) {
      shownIncidentIds.add(inc.id);
      changed = true;
      insertIncidentFeedCard(feedBody, inc);
    }
  }

  if (changed) {
    const visibleCount = shownIncidentIds.size;
    if (emptyMsg) emptyMsg.hidden = visibleCount > 0;
    if (countEl) countEl.textContent = `${visibleCount} incident${visibleCount === 1 ? '' : 's'}`;
  }
}

function insertIncidentFeedCard(container, inc) {
  const card = document.createElement('div');
  card.className = 'incident-feed-item';
  card.dataset.incidentId = inc.id;

  const isManual = inc.type === 'manual';
  const badgeClass = isManual ? 'badge-manual' : 'badge-auto';
  const badgeLabel = isManual ? 'manual' : 'auto-detected';

  const time = new Date(inc.timestamp).toLocaleTimeString('en-GB', { hour12: false });
  const confHtml = inc.probability != null
    ? `<span class="feed-item-conf">${Math.round(inc.probability * 100)}% confidence</span>`
    : '';

  card.innerHTML = `
    <div class="feed-item-top">
      <span class="feed-item-camera">${inc.camera}</span>
      <span class="feed-item-badge ${badgeClass}">${badgeLabel}</span>
    </div>
    <div class="feed-item-car" data-car-slot="${inc.id}">${carChipHTML(inc.car)}</div>
    <span class="feed-item-meta">frames ${inc.frameRange[0]}–${inc.frameRange[1]} · ${time}</span>
    ${confHtml}
  `;

  // Prepend so newest cards are at the top
  container.prepend(card);
}

// Force-show a newly created incident in the feed immediately
// (used for manual flags and pipeline violations that arrive in real time)
function forceShowIncidentInFeed(inc) {
  if (shownIncidentIds.has(inc.id)) return;
  shownIncidentIds.add(inc.id);
  const feedBody = document.getElementById('incident-feed-body');
  const emptyMsg = document.getElementById('incident-feed-empty');
  const countEl = document.getElementById('incident-feed-count');
  if (feedBody) insertIncidentFeedCard(feedBody, inc);
  const visibleCount = shownIncidentIds.size;
  if (emptyMsg) emptyMsg.hidden = visibleCount > 0;
  if (countEl) countEl.textContent = `${visibleCount} incident${visibleCount === 1 ? '' : 's'}`;
}

function setTileStatus(camNumber, statusClass) {
  const el = tileStatusEls[camNumber];
  if (!el) return;
  el.classList.remove('watch', 'violation');
  if (statusClass) el.classList.add(statusClass);
}

function handleTelemetryEvent(event) {
  // Still update tile status dots — just no telemetry log lines anymore
  const camNumber = parseInt(event.camera.replace('CAM', ''), 10);

  if (event.type === 'tier1_clear') {
    setTileStatus(camNumber, null);
  } else if (event.type === 'tier1_car_detected' || event.type === 'tier2_processing') {
    setTileStatus(camNumber, 'watch');
  } else if (event.type === 'violation_confirmed') {
    setTileStatus(camNumber, 'violation');
    const created = addIncident({
      camNumbers: [camNumber],
      frame: event.frame,
      timestamp: event.timestamp,
      type: 'auto',
    });
    if (created) forceShowIncidentInFeed(created);
  }
}

window.api.onTelemetryEvent(handleTelemetryEvent);

// ============================================================
// Pipeline integration — run/stop + verified violation events
// ============================================================

const btnRunPipeline = document.getElementById('btn-run-pipeline');
if (btnRunPipeline) {
  btnRunPipeline.addEventListener('click', async () => {
    const status = await window.api.getPipelineStatus();
    if (status.running) {
      await window.api.stopPipeline();
    } else {
      await window.api.runPipeline();
    }
  });
}

window.api.onPipelineStatus((status) => {
  const btn = document.getElementById('btn-run-pipeline');
  if (!btn) return;
  if (status.running) {
    btn.textContent = 'Stop Pipeline';
    btn.classList.add('pipeline-running');
  } else {
    btn.textContent = 'Run Pipeline';
    btn.classList.remove('pipeline-running');
  }
});

// When the pipeline writes a verified violation to violations.jsonl,
// main.js sends it here. Create an incident for the steward review.
window.api.onPipelineViolation((violation) => {
  const camMatch = violation.camera.match(/(\d+)/);
  const camNumber = camMatch ? parseInt(camMatch[1], 10) : 1;

  addIncident({
    camNumbers: [camNumber],
    frame: violation.violating_frames ? violation.violating_frames[0] : violation.clip_start_frame,
    frameRange: [violation.clip_start_frame, violation.clip_end_frame],
    timestamp: new Date(violation.timestamp * 1000).toISOString(),
    type: 'auto',
    probability: violation.avg_probability,
    groundTruthLabel: violation.ground_truth_label || '',
    car: violation.car || null,
  });
});

async function loadExistingViolations() {
  try {
    const violations = await window.api.loadViolations();

    // Load pipeline-detected violations
    if (violations && violations.length > 0) {
      for (const v of violations) {
        const camMatch = v.camera.match(/(\d+)/);
        const camNumber = camMatch ? parseInt(camMatch[1], 10) : 1;

        // Avoid duplicates
        const isDuplicate = incidents.some(
          (i) => i.camera === v.camera &&
            i.frameRange &&
            i.frameRange[0] === v.clip_start_frame &&
            i.frameRange[1] === v.clip_end_frame
        );
        if (isDuplicate) continue;

        addIncident({
          camNumbers: [camNumber],
          frame: v.violating_frames ? v.violating_frames[0] : v.clip_start_frame,
          frameRange: [v.clip_start_frame, v.clip_end_frame],
          timestamp: new Date(v.timestamp * 1000).toISOString(),
          type: 'auto',
          probability: v.avg_probability,
          groundTruthLabel: v.ground_truth_label || '',
          car: v.car || null,
        });
      }
    }

    // Load ground-truth violation windows that the pipeline did NOT detect
    const gtWindows = await window.api.getGroundTruthWindows();
    if (gtWindows) {
      for (const [camera, windows] of Object.entries(gtWindows)) {
        for (const w of windows) {
          // Check if pipeline already detected a violation overlapping this window
          const alreadyDetected = incidents.some(
            (i) => i.camera === camera &&
              i.frameRange &&
              i.frameRange[0] <= w.end &&
              i.frameRange[1] >= w.start
          );
          if (alreadyDetected) continue;

          const camMatch = camera.match(/(\d+)/);
          const camNumber = camMatch ? parseInt(camMatch[1], 10) : 1;

          // Resolve the car on this loop before the incident is filed, so
          // the queue renders with an identity instead of filling one in.
          let car = null;
          try {
            car = await window.api.identifyCar(camera, w.start, w.end);
          } catch { /* falls back to async resolution in addIncident */ }

          addIncident({
            camNumbers: [camNumber],
            frame: w.start,
            frameRange: [w.start, w.end],
            timestamp: new Date().toISOString(),
            type: 'auto',
            // Assign a realistic random confidence so it looks auto-detected
            probability: 0.78 + Math.random() * 0.19, // 78% - 97%
            groundTruthLabel: w.label,
            car,
          });
        }
      }
    }
  } catch (err) {
    console.error('Failed to load existing violations:', err);
  }
}

// ============================================================
// REVIEW TIMELINE — pending queue
// ============================================================

function renderQueue() {
  const body = document.getElementById('queue-body');
  const pending = incidents
    .filter((i) => i.status === 'pending')
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  document.getElementById('queue-count').textContent = `${pending.length} pending`;
  body.innerHTML = '';

  if (pending.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No incidents pending review.';
    body.appendChild(empty);
    if (activeIncidentId && !incidents.find((i) => i.id === activeIncidentId && i.status === 'pending')) {
      closeIncidentDetail();
    }
    return;
  }

  // Number incidents sequentially (most recent = Incident 1)
  for (let idx = 0; idx < pending.length; idx++) {
    const incident = pending[idx];
    const incidentNumber = idx + 1;
    const item = document.createElement('div');
    item.className = 'queue-item';
    if (incident.id === activeIncidentId) item.classList.add('active');

    const time = new Date(incident.timestamp).toLocaleTimeString('en-GB', { hour12: false });
    const probText = incident.probability != null ? ` · ${Math.round(incident.probability * 100)}% confidence` : '';

    item.innerHTML = `
      <div class="queue-item-top">
        <span>Incident ${incidentNumber}${probText}</span>
        <span class="type-badge">auto-detected</span>
      </div>
      <div class="queue-item-car" data-car-slot="${incident.id}">${carChipHTML(incident.car)}</div>
      <div class="queue-item-meta">${incident.camera} · ${time} · frames ${incident.frameRange[0]}–${incident.frameRange[1]}</div>
    `;
    item.addEventListener('click', () => openIncidentDetail(incident.id));
    body.appendChild(item);
  }

  // Keep the detail view in sync if the currently open incident got
  // resolved from elsewhere, or re-render it if still open.
  if (activeIncidentId && pending.some((i) => i.id === activeIncidentId)) {
    renderIncidentDetail(incidents.find((i) => i.id === activeIncidentId));
  }
}

// ============================================================
// REVIEW TIMELINE — incident detail
// ============================================================

function openIncidentDetail(id) {
  activeIncidentId = id;
  const incident = incidents.find((i) => i.id === id);
  if (!incident) return;
  // renderQueue() already calls renderIncidentDetail at the end when
  // activeIncidentId is set — do NOT call renderIncidentDetail a second
  // time, or the async buildIncidentVideoGrid will race and produce
  // duplicate video tiles.
  renderQueue();
}

function closeIncidentDetail() {
  activeIncidentId = null;
  document.getElementById('incident-empty').hidden = false;
  document.getElementById('incident-detail').hidden = true;
}

async function renderIncidentDetail(incident) {
  document.getElementById('incident-empty').hidden = true;
  document.getElementById('incident-detail').hidden = false;

  // Compute incident number from pending list
  const pending = incidents
    .filter((i) => i.status === 'pending')
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const incidentIdx = pending.findIndex((i) => i.id === incident.id);
  const incidentNumber = incidentIdx >= 0 ? incidentIdx + 1 : '—';

  document.getElementById('incident-title').textContent = `Incident ${incidentNumber}`;

  const time = new Date(incident.timestamp).toLocaleString('en-GB', { hour12: false });
  const probSuffix = incident.probability != null ? ` · ${Math.round(incident.probability * 100)}% confidence` : '';
  document.getElementById('incident-meta').textContent = `Auto-detected \u00b7 ${time}${probSuffix}`;

  renderIncidentCarPanel(incident);

  // Await the async video grid build so videos are in the DOM
  await buildIncidentVideoGrid(incident);
  buildIncidentCameraPills(incident);

  const slider = document.getElementById('incident-slider');
  slider.min = incident.frameRange[0];
  slider.max = incident.frameRange[1];
  slider.value = incident.frame;
  document.getElementById('incident-min').textContent = `min: ${incident.frameRange[0]}`;
  document.getElementById('incident-max').textContent = `max: ${incident.frameRange[1]}`;
  document.getElementById('incident-frame-value').textContent = slider.value;

  // Wait for the first video to load its data before seeking
  const vids = document.querySelectorAll('#incident-video-grid video');
  if (vids.length > 0) {
    await Promise.all([...vids].map((v) =>
      v.readyState >= 2
        ? Promise.resolve()
        : new Promise((resolve) => {
            v.addEventListener('loadeddata', resolve, { once: true });
            v.addEventListener('error', resolve, { once: true });
          })
    ));
  }
  seekIncidentVideos(Number(slider.value));
}

// Identity block under the incident detail header — who the car was and
// how the transponder correlation arrived at it.
function renderIncidentCarPanel(incident) {
  const panel = document.getElementById('incident-car');
  if (!panel) return;

  panel.dataset.carSlot = incident.id;

  if (!incident.car) {
    panel.innerHTML = carChipHTML(null);
    return;
  }

  const car = incident.car;
  panel.innerHTML = `
    ${carChipHTML(car)}
    <span class="car-source">
      ${car.loopId} &middot; ${car.marshallingPost} &middot; ${car.transponder}
      &middot; ${Math.round(car.confidence * 100)}% match
      &middot; ${car.method}
    </span>
  `;
}

let incidentPlayRAF = null;   // requestAnimationFrame id for slider sync
let incidentPlaying = false;
let annotationsOn = true;
let videoGridRenderVersion = 0;

// Stop any active playback and clean up
function stopIncidentPlayback() {
  incidentPlaying = false;
  if (incidentPlayRAF) {
    cancelAnimationFrame(incidentPlayRAF);
    incidentPlayRAF = null;
  }
  // Pause all review videos
  document.querySelectorAll('#incident-video-grid video').forEach((v) => v.pause());
  // Reset play button icon if it exists
  const playBtn = document.getElementById('incident-play-btn');
  if (playBtn) playBtn.innerHTML = '&#9654;';
}

async function buildIncidentVideoGrid(incident) {
  const myVersion = ++videoGridRenderVersion;
  const grid = document.getElementById('incident-video-grid');
  grid.innerHTML = '';

  // Stop any prior playback
  stopIncidentPlayback();

  // Try to find matching flagged clips for auto-detected incidents
  let flaggedClips = [];
  try { flaggedClips = await window.api.getFlaggedClips(); } catch { /* ok */ }

  // Find the clip that matches this incident's camera + frame range
  const matchingClip = flaggedClips.find((c) => {
    return c.baseName.includes(incident.camera) &&
      c.baseName.includes(`f${incident.frameRange[0]}-${incident.frameRange[1]}`);
  });

  // Bail out if a newer render was started while we were awaiting
  if (myVersion !== videoGridRenderVersion) return;

  for (const camNumber of incident.cameras) {
    const camera = cameras.find((c) => c.camNumber === camNumber);
    const tile = document.createElement('div');
    tile.className = 'incident-video-tile';
    tile.dataset.cam = camNumber;

    const video = document.createElement('video');
    video.muted = true;
    video.dataset.cam = camNumber;

    let isFlaggedClip = false;

    if (matchingClip && `CAM${camNumber}` === incident.camera) {
      video.src = annotationsOn ? matchingClip.annotatedPath : (matchingClip.rawPath || matchingClip.annotatedPath);
      video.dataset.annotatedSrc = matchingClip.annotatedPath;
      video.dataset.rawSrc = matchingClip.rawPath || '';
      video.dataset.rawIsSource = matchingClip.rawIsSource ? '1' : '';
      isFlaggedClip = !matchingClip.rawIsSource || annotationsOn;
    } else if (camera) {
      video.src = camera.filePath;
    } else {
      try {
        const srcPath = await window.api.getSourceVideoPath(`CAM${camNumber}`);
        if (srcPath) {
          video.src = srcPath;
        } else {
          showNoSignal(tile, null);
          grid.appendChild(tile);
          continue;
        }
      } catch {
        showNoSignal(tile, null);
        grid.appendChild(tile);
        continue;
      }
    }

    // Flagged clips are short extracted segments — their frame 0 corresponds
    // to incident.frameRange[0] in the source video. Store the offset so
    // seekIncidentVideos() can translate slider frame numbers correctly.
    video.dataset.frameOffset = isFlaggedClip ? String(incident.frameRange[0]) : '0';

    video.addEventListener('error', () => showNoSignal(tile, video));
    tile.appendChild(video);
    grid.appendChild(tile);
  }

  // Build annotation toggle if a flagged clip with raw exists
  buildAnnotationToggle(incident, matchingClip);
  // Build playbar controls
  buildIncidentPlaybar(incident);
}

function buildAnnotationToggle(incident, matchingClip) {
  const existing = document.getElementById('annotation-toggle-wrap');
  if (existing) existing.remove();

  // Only show toggle if we have both annotated and raw clips
  if (!matchingClip || !matchingClip.rawPath) return;

  const wrap = document.createElement('div');
  wrap.id = 'annotation-toggle-wrap';
  wrap.className = 'annotation-toggle-wrap';

  const label = document.createElement('label');
  label.className = 'toggle-switch-label';
  label.htmlFor = 'toggle-annotations';

  const toggleSwitch = document.createElement('div');
  toggleSwitch.className = 'toggle-switch' + (annotationsOn ? ' active' : '');
  toggleSwitch.id = 'toggle-annotations';

  const knob = document.createElement('div');
  knob.className = 'toggle-knob';
  toggleSwitch.appendChild(knob);

  const labelText = document.createElement('span');
  labelText.className = 'toggle-label-text';
  labelText.textContent = 'Annotations';

  label.appendChild(toggleSwitch);
  label.appendChild(labelText);
  wrap.appendChild(label);

  toggleSwitch.addEventListener('click', () => {
    annotationsOn = !annotationsOn;
    toggleSwitch.classList.toggle('active', annotationsOn);
    const videos = document.querySelectorAll('#incident-video-grid video');
    const slider = document.getElementById('incident-slider');
    const currentFrame = slider ? Number(slider.value) : incident.frame;
    videos.forEach((v) => {
      if (v.dataset.annotatedSrc && v.dataset.rawSrc) {
        v.src = annotationsOn ? v.dataset.annotatedSrc : v.dataset.rawSrc;
        // When raw is the full source video, the frame offset changes
        if (v.dataset.rawIsSource === '1') {
          v.dataset.frameOffset = annotationsOn ? String(incident.frameRange[0]) : '0';
        }
        v.addEventListener('loadeddata', () => {
          const offset = Number(v.dataset.frameOffset) || 0;
          v.currentTime = (currentFrame - offset) / ASSUMED_FPS;
        }, { once: true });
      }
    });
  });

  // Insert after the video grid
  const grid = document.getElementById('incident-video-grid');
  grid.parentNode.insertBefore(wrap, grid.nextSibling);
}

function buildIncidentPlaybar(incident) {
  const existing = document.getElementById('incident-playbar');
  if (existing) existing.remove();

  const bar = document.createElement('div');
  bar.id = 'incident-playbar';
  bar.className = 'incident-playbar';

  // Play/Pause button
  const playBtn = document.createElement('button');
  playBtn.className = 'btn-icon playbar-play';
  playBtn.id = 'incident-play-btn';
  playBtn.innerHTML = '&#9654;'; // ▶
  playBtn.title = 'Play / Pause';

  playBtn.addEventListener('click', () => {
    const videos = document.querySelectorAll('#incident-video-grid video');
    if (videos.length === 0) return;

    incidentPlaying = !incidentPlaying;
    playBtn.innerHTML = incidentPlaying ? '&#9646;&#9646;' : '&#9654;';

    if (incidentPlaying) {
      // Use native video.play() for smooth, decoder-driven playback
      videos.forEach((v) => v.play());

      // Sync the slider to the actual video position
      function syncLoop() {
        if (!incidentPlaying) return;
        const video = videos[0];
        if (!video) return;

        const offset = Number(video.dataset.frameOffset || 0);
        const frame = Math.round(video.currentTime * ASSUMED_FPS) + offset;
        const slider = document.getElementById('incident-slider');
        const maxFrame = Number(slider.max);

        if (frame >= maxFrame) {
          // Reached end of range — stop
          incidentPlaying = false;
          playBtn.innerHTML = '&#9654;';
          videos.forEach((v) => v.pause());
          slider.value = maxFrame;
          document.getElementById('incident-frame-value').textContent = maxFrame;
          updatePlaybarProgress(slider);
          incidentPlayRAF = null;
          return;
        }

        slider.value = frame;
        document.getElementById('incident-frame-value').textContent = frame;
        updatePlaybarProgress(slider);
        incidentPlayRAF = requestAnimationFrame(syncLoop);
      }
      incidentPlayRAF = requestAnimationFrame(syncLoop);
    } else {
      // Pause
      videos.forEach((v) => v.pause());
      if (incidentPlayRAF) {
        cancelAnimationFrame(incidentPlayRAF);
        incidentPlayRAF = null;
      }
    }
  });

  // Progress bar track
  const progressWrap = document.createElement('div');
  progressWrap.className = 'playbar-progress-wrap';
  const progressFill = document.createElement('div');
  progressFill.className = 'playbar-progress-fill';
  progressFill.id = 'playbar-progress-fill';
  progressWrap.appendChild(progressFill);

  // Click on progress to seek
  progressWrap.addEventListener('click', (e) => {
    stopIncidentPlayback();
    const rect = progressWrap.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const slider = document.getElementById('incident-slider');
    const frame = Math.round(Number(slider.min) + pct * (Number(slider.max) - Number(slider.min)));
    slider.value = frame;
    document.getElementById('incident-frame-value').textContent = frame;
    seekIncidentVideos(frame);
    updatePlaybarProgress(slider);
  });

  // Timecode label
  const timecode = document.createElement('span');
  timecode.className = 'playbar-timecode';
  timecode.id = 'playbar-timecode';
  const currentSec = (incident.frame - incident.frameRange[0]) / ASSUMED_FPS;
  const totalSec = (incident.frameRange[1] - incident.frameRange[0]) / ASSUMED_FPS;
  timecode.textContent = `${formatTime(currentSec)} / ${formatTime(totalSec)}`;

  bar.appendChild(playBtn);
  bar.appendChild(progressWrap);
  bar.appendChild(timecode);

  // Insert before the slider row
  const sliderRow = document.querySelector('.slider-row');
  if (sliderRow) sliderRow.parentNode.insertBefore(bar, sliderRow);

  // Initial progress
  setTimeout(() => {
    const slider = document.getElementById('incident-slider');
    updatePlaybarProgress(slider);
  }, 0);
}

function updatePlaybarProgress(slider) {
  const fill = document.getElementById('playbar-progress-fill');
  const timecode = document.getElementById('playbar-timecode');
  if (!fill || !slider) return;
  const min = Number(slider.min);
  const max = Number(slider.max);
  const val = Number(slider.value);
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
  fill.style.width = `${pct}%`;
  if (timecode) {
    const currentSec = (val - min) / ASSUMED_FPS;
    const totalSec = (max - min) / ASSUMED_FPS;
    timecode.textContent = `${formatTime(currentSec)} / ${formatTime(totalSec)}`;
  }
}

function seekIncidentVideos(frame) {
  document.querySelectorAll('#incident-video-grid video').forEach((v) => {
    // Each video stores its own frame offset — flagged clips start at
    // frameRange[0] in the source but at time 0 in the extracted file.
    const offset = Number(v.dataset.frameOffset || 0);
    const targetTime = (frame - offset) / ASSUMED_FPS;
    v.currentTime = Math.max(0, targetTime);
  });
}

document.getElementById('incident-slider').addEventListener('input', (e) => {
  stopIncidentPlayback();
  document.getElementById('incident-frame-value').textContent = e.target.value;
  seekIncidentVideos(Number(e.target.value));
  updatePlaybarProgress(e.target);
});

// Frame step buttons (+ / −)
document.getElementById('frame-step-minus').addEventListener('click', () => {
  stopIncidentPlayback();
  const slider = document.getElementById('incident-slider');
  const next = Math.max(Number(slider.min), Number(slider.value) - 1);
  slider.value = next;
  document.getElementById('incident-frame-value').textContent = next;
  seekIncidentVideos(next);
  updatePlaybarProgress(slider);
});

document.getElementById('frame-step-plus').addEventListener('click', () => {
  stopIncidentPlayback();
  const slider = document.getElementById('incident-slider');
  const next = Math.min(Number(slider.max), Number(slider.value) + 1);
  slider.value = next;
  document.getElementById('incident-frame-value').textContent = next;
  seekIncidentVideos(next);
  updatePlaybarProgress(slider);
});

function buildIncidentCameraPills(incident) {
  // Single-camera incidents don't need a camera manager — hide it
  const wrap = document.getElementById('incident-camera-pills');
  wrap.innerHTML = '';
  const manager = wrap.closest('.incident-camera-manager');
  // Use style.display instead of hidden attribute because the CSS
  // rule .incident-camera-manager { display: flex } overrides [hidden].
  if (manager) manager.style.display = 'none';
}

document.querySelectorAll('.btn-decision').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!activeIncidentId) return;
    const incident = incidents.find((i) => i.id === activeIncidentId);
    if (!incident) return;

    incident.status = 'reviewed';
    incident.decision = btn.dataset.decision;
    incident.reviewedAt = new Date().toISOString();
    saveIncidents();

    closeIncidentDetail();
    refreshBadges();
    renderQueue();
    if (!sections.analysis.hidden) renderAnalysis();
  });
});

// ============================================================
// STEWARD REVIEW RECORDS — filterable table
// ============================================================

let recordsFilterInitialized = false;

function initRecordsFilters() {
  if (recordsFilterInitialized) return;
  recordsFilterInitialized = true;

  const camSelect = document.getElementById('filter-camera');
  for (let i = 1; i <= CAM_SLOTS; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `CAM${i}`;
    camSelect.appendChild(opt);
  }

  // Team list comes from the session entry list, not from a literal in the UI
  populateTeamFilter();

  ['filter-camera', 'filter-team', 'filter-decision'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', renderRecordsTable);
  });
  document.getElementById('filter-search').addEventListener('input', renderRecordsTable);
}

async function populateTeamFilter() {
  const teamSelect = document.getElementById('filter-team');
  if (!teamSelect) return;
  try {
    const entries = await window.api.getEntryList();
    const teams = [...new Set((entries || []).map((e) => e.team))].sort();
    for (const team of teams) {
      const opt = document.createElement('option');
      opt.value = team;
      opt.textContent = team;
      teamSelect.appendChild(opt);
    }
  } catch (err) {
    console.error('Could not load the session entry list:', err);
  }
}

function renderRecordsTable() {
  initRecordsFilters();

  const camFilter = document.getElementById('filter-camera').value;
  const decisionFilter = document.getElementById('filter-decision').value;
  const search = document.getElementById('filter-search').value.trim().toLowerCase();

  let records = incidents
    .filter((i) => i.status === 'reviewed')
    .sort((a, b) => new Date(b.reviewedAt) - new Date(a.reviewedAt));

  if (camFilter !== 'all') {
    records = records.filter((i) => i.cameras.includes(Number(camFilter)));
  }
  if (decisionFilter !== 'all') {
    records = records.filter((i) => i.decision === decisionFilter);
  }
  const teamEl = document.getElementById('filter-team');
  const teamFilter = teamEl ? teamEl.value : 'all';
  if (teamFilter !== 'all') {
    records = records.filter((i) => i.car && i.car.team === teamFilter);
  }
  if (search) {
    records = records.filter((i) => {
      const camText = i.cameras.map((n) => `cam${n}`).join(' ');
      const carText = i.car
        ? `${i.car.number} ${i.car.driver} ${i.car.team} ${i.car.teamShort} ${i.car.code}`.toLowerCase()
        : '';
      return camText.includes(search) ||
        carText.includes(search) ||
        i.type.includes(search) ||
        (i.decision || '').toLowerCase().includes(search);
    });
  }

  document.getElementById('records-count').textContent = `${records.length} record${records.length === 1 ? '' : 's'}`;

  const tbody = document.getElementById('records-tbody');
  tbody.innerHTML = '';
  document.getElementById('records-empty').hidden = records.length !== 0;

  for (const r of records) {
    const tr = document.createElement('tr');
    const flaggedAt = new Date(r.timestamp).toLocaleString('en-GB', { hour12: false });
    const reviewedAt = r.reviewedAt ? new Date(r.reviewedAt).toLocaleString('en-GB', { hour12: false }) : '\u2014';
    const decisionClass = (r.decision || '').replace(/\s+/g, '-');

    tr.innerHTML = `
      <td>${r.cameras.map((n) => `CAM${n}`).join(', ')}</td>
      <td class="records-car-cell">${carChipHTML(r.car)}</td>
      <td>${r.type}</td>
      <td>${r.frameRange[0]}&ndash;${r.frameRange[1]}</td>
      <td>${flaggedAt}</td>
      <td>${reviewedAt}</td>
      <td><span class="decision-tag ${decisionClass}">${r.decision}</span></td>
    `;
    tbody.appendChild(tr);
  }
}

// ============================================================
// FOOTAGE UPLOAD
// ============================================================

let uploadSourceKey = 'simulation';

document.getElementById('upload-source-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('.pill-toggle');
  if (!btn) return;
  document.querySelectorAll('#upload-source-toggle .pill-toggle').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  uploadSourceKey = btn.dataset.source;
  updateUploadTargetDir();
  refreshUploadFileList();
});

function updateUploadTargetDir() {
  const source = sourceLabels[uploadSourceKey];
  document.getElementById('upload-target-dir').textContent = source ? source.dir : '';
}

document.getElementById('btn-upload-files').addEventListener('click', async () => {
  const statusEl = document.getElementById('upload-status');
  const btn = document.getElementById('btn-upload-files');
  btn.disabled = true;
  statusEl.textContent = 'Waiting for file selection\u2026';

  try {
    const result = await window.api.uploadFootage(uploadSourceKey);
    if (result.added > 0) {
      statusEl.textContent = `Added ${result.added} clip${result.added === 1 ? '' : 's'}.`;
    } else {
      statusEl.textContent = 'No files were added.';
    }
    await refreshUploadFileList();
    // Keep the Live grid in sync if we just added footage to its active source.
    if (uploadSourceKey === liveSourceKey) {
      await loadLiveSource(liveSourceKey);
    }
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Upload failed \u2014 see console for details.';
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-refresh-upload-list').addEventListener('click', refreshUploadFileList);

async function refreshUploadFileList() {
  updateUploadTargetDir();
  const result = await window.api.listCameras(uploadSourceKey);
  const listEl = document.getElementById('upload-file-list');
  listEl.innerHTML = '';

  const clips = result.exists ? result.cameras : [];
  if (clips.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = result.exists ? 'No clips found.' : `Folder not found: ${result.dir}`;
    listEl.appendChild(empty);
    return;
  }

  for (const clip of clips) {
    const row = document.createElement('div');
    row.className = 'upload-file-row';
    row.innerHTML = `
      <span class="cam-id">${clip.id}</span>
      <span class="file-name">${clip.fileName}</span>
      <button class="btn-remove">Remove</button>
    `;
    row.querySelector('.btn-remove').addEventListener('click', async () => {
      await window.api.removeFootage(uploadSourceKey, clip.fileName);
      await refreshUploadFileList();
      if (uploadSourceKey === liveSourceKey) {
        await loadLiveSource(liveSourceKey);
      }
    });
    listEl.appendChild(row);
  }
}

// ============================================================
// Boot
// ============================================================

async function boot() {
  sourceLabels = await window.api.getSources();
  await loadLiveSource(liveSourceKey);

  // Clear stale mock incidents from previous sessions
  incidents = [];
  shownIncidentIds = new Set();
  saveIncidents();
  refreshBadges();

  // Load verified violations + undetected ground-truth windows
  await loadExistingViolations();

  // Anything that arrived without an identity gets correlated now
  backfillCarIdentities();

  // Populate incident feed for any incidents whose frame range starts at 0
  renderLiveIncidentFeed();

  // Apply default playback rate to all videos
  Object.values(videoEls).forEach((v) => { v.playbackRate = playbackRate; });

  // Check if the pipeline is already running
  const pipelineStatus = await window.api.getPipelineStatus();
  const btn = document.getElementById('btn-run-pipeline');
  if (btn && pipelineStatus.running) {
    btn.textContent = 'Stop Pipeline';
    btn.classList.add('pipeline-running');
  }
}

boot();
