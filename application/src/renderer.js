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
  upload: document.getElementById('section-upload'),
};

document.getElementById('side-nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-item');
  if (!btn) return;
  showSection(btn.dataset.section);
});

function showSection(name) {
  for (const [key, el] of Object.entries(sections)) {
    el.hidden = key !== name;
  }
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.section === name);
  });

  if (name === 'review') renderQueue();
  if (name === 'records') renderRecordsTable();
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

function addIncident({ camNumbers, frame, timestamp, type }) {
  const sorted = [...camNumbers].sort((a, b) => a - b);
  const incident = {
    id: genId(),
    camera: `CAM${sorted[0]}`,
    cameras: sorted,
    frame,
    frameRange: [Math.max(0, frame - 100), frame + 200],
    timestamp,
    type, // 'auto' | 'manual'
    status: 'pending', // 'pending' | 'reviewed'
    decision: null,
    reviewedAt: null,
  };
  incidents.unshift(incident);
  saveIncidents();
  refreshBadges();
  if (!sections.review.hidden) renderQueue();
  return incident;
}

function refreshBadges() {
  const pendingCount = incidents.filter((i) => i.status === 'pending').length;

  const pill = document.getElementById('alert-count-pill');
  pill.textContent = `${pendingCount} pending`;
  pill.classList.toggle('has-alerts', pendingCount > 0);

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
}

syncToggleBtn.addEventListener('click', () => {
  isPlaying = !isPlaying;
  Object.values(videoEls).forEach((v) => (isPlaying ? v.play() : v.pause()));
  syncToggleBtn.textContent = isPlaying ? 'Pause all' : 'Play all';
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
  addIncident({ camNumbers, frame, timestamp: new Date().toISOString(), type: 'manual' });
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
// Telemetry stream (shown in Live) + auto incident creation
// ============================================================

const telemetryBody = document.getElementById('telemetry-body');

const EVENT_LABELS = {
  tier1_clear: 'tier1',
  tier1_car_detected: 'tier1',
  tier2_processing: 'tier2',
  violation_confirmed: 'tier2',
};

const EVENT_MESSAGES = {
  tier1_clear: 'no vehicle in frame',
  tier1_car_detected: 'vehicle detected, buffer locked',
  tier2_processing: 'pose + segmentation running on locked slice',
  violation_confirmed: 'track limit violation confirmed',
};

function appendTelemetryLine(event) {
  const line = document.createElement('div');
  line.className = 'telemetry-line';
  if (event.type === 'violation_confirmed') line.classList.add('violation');
  else if (event.type === 'tier2_processing' || event.type === 'tier1_car_detected') line.classList.add('watch');

  const time = new Date(event.timestamp).toLocaleTimeString('en-GB', { hour12: false });
  line.innerHTML = `<span class="tag">[${time}][${EVENT_LABELS[event.type]}][${event.camera}]</span> ${EVENT_MESSAGES[event.type]}`;
  telemetryBody.appendChild(line);
  telemetryBody.scrollTop = telemetryBody.scrollHeight;

  while (telemetryBody.children.length > 200) {
    telemetryBody.removeChild(telemetryBody.firstChild);
  }
}

function setTileStatus(camNumber, statusClass) {
  const el = tileStatusEls[camNumber];
  if (!el) return;
  el.classList.remove('watch', 'violation');
  if (statusClass) el.classList.add(statusClass);
}

function handleTelemetryEvent(event) {
  appendTelemetryLine(event);
  const camNumber = parseInt(event.camera.replace('CAM', ''), 10);

  if (event.type === 'tier1_clear') {
    setTileStatus(camNumber, null);
  } else if (event.type === 'tier1_car_detected' || event.type === 'tier2_processing') {
    setTileStatus(camNumber, 'watch');
  } else if (event.type === 'violation_confirmed') {
    setTileStatus(camNumber, 'violation');
    addIncident({
      camNumbers: [camNumber],
      frame: event.frame,
      timestamp: event.timestamp,
      type: 'auto',
    });
  }
}

window.api.onTelemetryEvent(handleTelemetryEvent);

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

  for (const incident of pending) {
    const item = document.createElement('div');
    item.className = 'queue-item';
    if (incident.id === activeIncidentId) item.classList.add('active');

    const time = new Date(incident.timestamp).toLocaleTimeString('en-GB', { hour12: false });
    const camLabel = incident.cameras.length > 1
      ? `${incident.cameras.length} cameras`
      : incident.camera;

    item.innerHTML = `
      <div class="queue-item-top">
        <span>${camLabel}</span>
        <span class="type-badge ${incident.type === 'manual' ? 'manual' : ''}">${incident.type}</span>
      </div>
      <div class="queue-item-meta">${time} &middot; frame ${incident.frame}</div>
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
  renderQueue();
  renderIncidentDetail(incident);
}

function closeIncidentDetail() {
  activeIncidentId = null;
  document.getElementById('incident-empty').hidden = false;
  document.getElementById('incident-detail').hidden = true;
}

function renderIncidentDetail(incident) {
  document.getElementById('incident-empty').hidden = true;
  document.getElementById('incident-detail').hidden = false;

  document.querySelectorAll('.queue-item').forEach((el, idx) => {
    // handled by class toggling in renderQueue(); nothing extra here
  });

  const title = incident.cameras.length > 1
    ? `Incident \u2014 ${incident.cameras.map((n) => `CAM${n}`).join(', ')}`
    : `Incident \u2014 ${incident.camera}`;
  document.getElementById('incident-title').textContent = title;

  const time = new Date(incident.timestamp).toLocaleString('en-GB', { hour12: false });
  document.getElementById('incident-meta').textContent = `${incident.type === 'manual' ? 'Manually flagged' : 'Auto-detected'} \u00b7 ${time}`;

  buildIncidentVideoGrid(incident);
  buildIncidentCameraPills(incident);

  const slider = document.getElementById('incident-slider');
  slider.min = incident.frameRange[0];
  slider.max = incident.frameRange[1];
  slider.value = incident.frame;
  document.getElementById('incident-min').textContent = `min: ${incident.frameRange[0]}`;
  document.getElementById('incident-max').textContent = `max: ${incident.frameRange[1]}`;
  document.getElementById('incident-frame-value').textContent = slider.value;
  seekIncidentVideos(Number(slider.value));
}

function buildIncidentVideoGrid(incident) {
  const grid = document.getElementById('incident-video-grid');
  grid.innerHTML = '';

  for (const camNumber of incident.cameras) {
    const camera = cameras.find((c) => c.camNumber === camNumber);
    const tile = document.createElement('div');
    tile.className = 'incident-video-tile';
    tile.dataset.cam = camNumber;

    const label = document.createElement('span');
    label.className = 'tile-label';
    label.textContent = `CAM${camNumber}`;
    tile.appendChild(label);

    if (camera) {
      const video = document.createElement('video');
      video.src = camera.filePath;
      video.muted = true;
      video.addEventListener('error', () => showNoSignal(tile, video));
      tile.appendChild(video);
    } else {
      showNoSignal(tile, null);
    }

    grid.appendChild(tile);
  }
}

function seekIncidentVideos(frame) {
  const targetTime = frame / ASSUMED_FPS;
  document.querySelectorAll('#incident-video-grid video').forEach((v) => {
    v.currentTime = targetTime;
  });
}

document.getElementById('incident-slider').addEventListener('input', (e) => {
  document.getElementById('incident-frame-value').textContent = e.target.value;
  seekIncidentVideos(Number(e.target.value));
});

function buildIncidentCameraPills(incident) {
  const wrap = document.getElementById('incident-camera-pills');
  wrap.innerHTML = '';

  for (let i = 1; i <= CAM_SLOTS; i++) {
    const hasFootage = cameras.some((c) => c.camNumber === i);
    const included = incident.cameras.includes(i);

    const pill = document.createElement('button');
    pill.className = 'camera-pill';
    if (included) pill.classList.add('active');
    if (!hasFootage) pill.classList.add('no-signal');
    pill.textContent = `CAM${i}`;

    pill.addEventListener('click', () => {
      if (included) {
        if (incident.cameras.length === 1) return; // keep at least one camera
        incident.cameras = incident.cameras.filter((n) => n !== i);
      } else {
        incident.cameras = [...incident.cameras, i].sort((a, b) => a - b);
      }
      incident.camera = `CAM${incident.cameras[0]}`;
      saveIncidents();
      renderIncidentDetail(incident);
      renderQueue();
    });

    wrap.appendChild(pill);
  }
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

  ['filter-camera', 'filter-decision'].forEach((id) => {
    document.getElementById(id).addEventListener('change', renderRecordsTable);
  });
  document.getElementById('filter-search').addEventListener('input', renderRecordsTable);
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
  if (search) {
    records = records.filter((i) => {
      const camText = i.cameras.map((n) => `cam${n}`).join(' ');
      return camText.includes(search) || i.type.includes(search) || (i.decision || '').toLowerCase().includes(search);
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
  refreshBadges();
}

boot();
