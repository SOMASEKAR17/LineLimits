// ------------------------------------------------------------------
// Car identification — Node/Electron side.
//
// Mirror of pipeline/car_identifier.py so the dashboard can resolve an
// identity for incidents that never went through the Python pipeline
// (ground-truth windows, manual steward flags) without shelling out.
//
// Every marshalling post has a transponder loop co-located with its
// camera. transponder_feed.jsonl is that loop output for the session:
// one dwell record per (loop, car) pass with the frame window the car
// spent inside the loop field and the peak RSSI of the read.
// session_entry_list.json maps car numbers to drivers and teams.
//
// Identification is a correlation over that feed — the reads on the
// violation's own camera are scored on how much of the violation window
// they cover and how strong the read was, and the best-scoring car wins.
// ------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const RSSI_FLOOR_DBM = -95;
const RSSI_CEIL_DBM = -30;
const W_COVERAGE = 0.75;
const W_SIGNAL = 0.25;
const MIN_ACCEPT_SCORE = 0.25;

function camKey(raw) {
  const m = String(raw || '').match(/(\d+)/);
  return m ? `CAM${parseInt(m[1], 10)}` : String(raw || '').toUpperCase();
}

function normaliseRssi(rssi) {
  const span = RSSI_CEIL_DBM - RSSI_FLOOR_DBM;
  return Math.max(0, Math.min(1, (rssi - RSSI_FLOOR_DBM) / span));
}

class CarIdentifier {
  constructor(pipelineDir) {
    this.entryListFile = path.join(pipelineDir, 'session_entry_list.json');
    this.feedFile = path.join(pipelineDir, 'transponder_feed.jsonl');

    this.entries = new Map();   // car number -> entry
    this.loops = new Map();     // camera -> loop
    this.readsByCamera = new Map();

    this.loadEntryList();
    this.loadFeed();
  }

  loadEntryList() {
    if (!fs.existsSync(this.entryListFile)) {
      console.warn(`[carIdentifier] Entry list not found: ${this.entryListFile}`);
      return;
    }
    try {
      const data = JSON.parse(fs.readFileSync(this.entryListFile, 'utf-8'));
      for (const entry of data.entries || []) {
        this.entries.set(Number(entry.car), entry);
      }
      for (const loop of data.loops || []) {
        this.loops.set(camKey(loop.camera), loop);
      }
    } catch (err) {
      console.error('[carIdentifier] Failed to parse entry list:', err.message);
    }
  }

  loadFeed() {
    if (!fs.existsSync(this.feedFile)) {
      console.warn(`[carIdentifier] Transponder feed not found: ${this.feedFile}`);
      return;
    }
    const text = fs.readFileSync(this.feedFile, 'utf-8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let read;
      try { read = JSON.parse(trimmed); } catch { continue; }
      if (read.valid === false) continue;

      const cam = camKey(read.camera);
      if (!this.readsByCamera.has(cam)) this.readsByCamera.set(cam, []);
      this.readsByCamera.get(cam).push(read);
    }
  }

  /** Score every loop read on this camera that overlaps the window. */
  candidates(camera, startFrame, endFrame) {
    const cam = camKey(camera);
    const start = Number(startFrame);
    const end = Number(endFrame);
    const window = Math.max(1, end - start);
    const reads = this.readsByCamera.get(cam) || [];
    const scored = [];

    for (const read of reads) {
      const overlap = Math.min(read.exit_frame, end) - Math.max(read.enter_frame, start);
      if (overlap <= 0) continue;

      const coverage = Math.min(1, overlap / window);
      const signal = normaliseRssi(read.peak_rssi_dbm ?? RSSI_FLOOR_DBM);
      const score = W_COVERAGE * coverage + W_SIGNAL * signal;

      scored.push({
        car: Number(read.car),
        loopId: read.loop_id || '',
        marshallingPost: read.marshalling_post || '',
        overlapFrames: overlap,
        coverage,
        signal,
        peakRssiDbm: read.peak_rssi_dbm,
        score,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  /** Resolve the car in this violation window, or null if no read supports one. */
  identify(camera, startFrame, endFrame) {
    const ranked = this.candidates(camera, startFrame, endFrame);
    if (ranked.length === 0) return null;

    const best = ranked[0];
    if (best.score < MIN_ACCEPT_SCORE) return null;

    const entry = this.entries.get(best.car);
    if (!entry) return null;

    const runnerUp = ranked.length > 1 ? ranked[1].score : 0;
    const margin = best.score - runnerUp;
    const confidence = Math.min(0.999, best.score * (0.85 + 0.15 * Math.min(1, margin / 0.5)));

    return {
      number: entry.car,
      driver: entry.driver,
      code: entry.code || '',
      team: entry.team,
      teamShort: entry.team_short || entry.team,
      teamColour: entry.colour || '#9CA3AF',
      transponder: entry.transponder || '',
      loopId: best.loopId,
      marshallingPost: best.marshallingPost,
      coverage: Number(best.coverage.toFixed(4)),
      peakRssiDbm: best.peakRssiDbm,
      confidence: Number(confidence.toFixed(4)),
      contested: ranked.length > 1,
      method: 'transponder-loop correlation',
    };
  }
}

module.exports = { CarIdentifier };
