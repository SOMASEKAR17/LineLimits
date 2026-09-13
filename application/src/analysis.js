// ============================================================
// ANALYSIS
//
// Everything here is derived from two sources and nothing else:
//   - `incidents`  — the current session, as the dashboard sees it
//   - session_history.jsonl — archived race control records from the
//     earlier rounds of the season, resolved against the same entry
//     list the live pipeline uses
//
// Cameras are addressed by the corner they cover: the loop metadata in
// session_entry_list.json maps CAM-n to Turn n, so nothing in this file
// spells out a corner name.
// ============================================================

const VIZ = {
  primary: '#B45309',   // single-series magnitude — the app's own accent family
  upheld: '#B91C1C',
  rejected: '#2563EB',
  pending: '#B45309',
  grid: '#E5E7EB',
  axis: '#D1D5DB',
  muted: '#9CA3AF',
  ink: '#111827',
  surface: '#FFFFFF',
  track: '#D1D5DB',
};

// Sequential ramp, one hue light -> dark. Index 0 means "none".
const HEAT_RAMP = ['#F1F2F4', '#FBE3C4', '#F6C285', '#EC9E4C', '#D2790F', '#B45309'];

const ANALYSIS_FPS = 30;
const TIMELINE_BIN_FRAMES = 300;   // 10 s at 30 fps
const TIMELINE_BINS = 12;          // 2-minute clips

let analysisLoops = [];
let analysisEntries = [];
let analysisHistory = [];
let analysisDataReady = false;
let analysisDataPromise = null;

// ------------------------------------------------------------
// Data
// ------------------------------------------------------------

function loadAnalysisData() {
  if (analysisDataPromise) return analysisDataPromise;

  analysisDataPromise = (async () => {
    const [loops, entries, history] = await Promise.all([
      window.api.getTrackLoops().catch(() => []),
      window.api.getEntryList().catch(() => []),
      window.api.getSessionHistory().catch(() => []),
    ]);
    analysisLoops = loops || [];
    analysisEntries = entries || [];
    analysisHistory = history || [];
    analysisDataReady = true;
  })();

  return analysisDataPromise;
}

function cornerOf(camera) {
  const loop = analysisLoops.find((l) => l.camera === camera);
  if (loop && loop.corner) return loop.corner;
  const m = String(camera || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function cornerLabel(corner) {
  return corner ? `Turn ${corner}` : 'Unknown';
}

function cornerShort(corner) {
  return corner ? `T${corner}` : '—';
}

function archivedRounds() {
  return [...new Set(analysisHistory.map((r) => r.round))].sort((a, b) => a - b);
}

function currentRound() {
  const rounds = archivedRounds();
  return rounds.length ? rounds[rounds.length - 1] + 1 : 1;
}

function currentRoundLabel() {
  return `R${currentRound()}`;
}

/** The current session's incidents, flattened into the shared record shape. */
function currentSessionRecords() {
  return incidents.map((inc) => {
    const reviewed = inc.status === 'reviewed';
    let reviewSeconds = null;
    if (reviewed && inc.reviewedAt && inc.timestamp) {
      reviewSeconds = Math.max(0, (new Date(inc.reviewedAt) - new Date(inc.timestamp)) / 1000);
    }
    return {
      round: currentRound(),
      sessionLabel: currentRoundLabel(),
      current: true,
      camera: inc.camera,
      corner: cornerOf(inc.camera),
      car: inc.car || null,
      startFrame: inc.frameRange ? inc.frameRange[0] : 0,
      decision: reviewed ? inc.decision : 'Pending',
      reviewSeconds,
    };
  });
}

function archivedRecords() {
  return analysisHistory.map((r) => ({
    round: r.round,
    sessionLabel: r.session_id,
    current: false,
    camera: r.camera,
    corner: r.corner || cornerOf(r.camera),
    car: r.car || null,
    startFrame: r.clip_start_frame || 0,
    decision: r.decision || 'Pending',
    reviewSeconds: typeof r.review_seconds === 'number' ? r.review_seconds : null,
  }));
}

// ------------------------------------------------------------
// Filters — one row, scoping every chart on the tab
// ------------------------------------------------------------

const analysisFilters = { corner: 'all', team: 'all', decision: 'all' };
let analysisFiltersBuilt = false;

function buildAnalysisFilters() {
  if (analysisFiltersBuilt) return;
  analysisFiltersBuilt = true;

  const cornerSelect = document.getElementById('analysis-filter-corner');
  for (const loop of [...analysisLoops].sort((a, b) => a.corner - b.corner)) {
    const opt = document.createElement('option');
    opt.value = String(loop.corner);
    opt.textContent = `${cornerLabel(loop.corner)} · ${loop.camera}`;
    cornerSelect.appendChild(opt);
  }

  const teamSelect = document.getElementById('analysis-filter-team');
  for (const team of [...new Set(analysisEntries.map((e) => e.team))].sort()) {
    const opt = document.createElement('option');
    opt.value = team;
    opt.textContent = team;
    teamSelect.appendChild(opt);
  }

  cornerSelect.addEventListener('change', (e) => {
    analysisFilters.corner = e.target.value;
    renderAnalysis();
  });
  teamSelect.addEventListener('change', (e) => {
    analysisFilters.team = e.target.value;
    renderAnalysis();
  });
  document.getElementById('analysis-filter-decision').addEventListener('change', (e) => {
    analysisFilters.decision = e.target.value;
    renderAnalysis();
  });
  document.getElementById('analysis-filter-reset').addEventListener('click', () => {
    analysisFilters.corner = 'all';
    analysisFilters.team = 'all';
    analysisFilters.decision = 'all';
    cornerSelect.value = 'all';
    teamSelect.value = 'all';
    document.getElementById('analysis-filter-decision').value = 'all';
    renderAnalysis();
  });
}

function applyFilters(records) {
  return records.filter((r) => {
    if (analysisFilters.corner !== 'all' && String(r.corner) !== analysisFilters.corner) return false;
    if (analysisFilters.team !== 'all' && (!r.car || r.car.team !== analysisFilters.team)) return false;
    if (analysisFilters.decision !== 'all' && r.decision !== analysisFilters.decision) return false;
    return true;
  });
}

// ------------------------------------------------------------
// Small SVG helpers
// ------------------------------------------------------------

function esc(value) {
  return String(value).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

function niceTicks(max, count = 4) {
  const top = Math.max(1, max);
  const step = Math.max(1, Math.ceil(top / count));
  const ticks = [];
  for (let v = 0; v <= step * count; v += step) ticks.push(v);
  return { ticks, max: ticks[ticks.length - 1] };
}

/** Rounded at the data end, square at the baseline. */
function columnPath(x, y, w, h, r = 4) {
  const radius = Math.max(0, Math.min(r, w / 2, h));
  if (h <= 0) return '';
  return `M${x},${y + h} L${x},${y + radius} Q${x},${y} ${x + radius},${y} ` +
         `L${x + w - radius},${y} Q${x + w},${y} ${x + w},${y + radius} L${x + w},${y + h} Z`;
}

function emptyState(message) {
  return `<p class="empty-state chart-empty">${esc(message)}</p>`;
}

function chartTable(headers, rows) {
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows.map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<div class="chart-table-scroll"><table class="chart-table">
    <thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Every chart ships with the equivalent table, toggled from the card header. */
function chartShell(visual, table) {
  return `<div class="chart-visual">${visual}</div>
          <div class="chart-table-wrap" hidden>${table}</div>`;
}

function legendRow(items) {
  return `<div class="chart-legend">${items.map((i) => `
    <span class="legend-item">
      <span class="legend-swatch" style="background:${i.colour}"></span>${esc(i.label)}
    </span>`).join('')}</div>`;
}

function formatDuration(seconds) {
  if (seconds == null) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function formatClock(frames) {
  const total = Math.round(frames / ANALYSIS_FPS);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------
// 1. Incidents by corner — column chart, single series
// ------------------------------------------------------------

function renderCornerChart(records) {
  const corners = [...analysisLoops].sort((a, b) => a.corner - b.corner);
  const counts = corners.map((loop) => ({
    corner: loop.corner,
    camera: loop.camera,
    label: cornerShort(loop.corner),
    value: records.filter((r) => r.corner === loop.corner).length,
  }));

  const table = chartTable(
    ['Corner', 'Camera', 'Incidents'],
    counts.map((c) => [cornerLabel(c.corner), c.camera, c.value]),
  );

  if (records.length === 0) {
    return chartShell(emptyState('No incidents in the current scope.'), table);
  }

  const W = 620, H = 236;
  const padL = 36, padR = 14, padT = 20, padB = 38;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const { ticks, max } = niceTicks(Math.max(...counts.map((c) => c.value)));
  const band = plotW / counts.length;
  const barW = Math.min(24, band * 0.5);
  const peak = Math.max(...counts.map((c) => c.value));

  const gridlines = ticks.map((t) => {
    const y = padT + plotH - (t / max) * plotH;
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${VIZ.grid}" stroke-width="1" />
            <text x="${padL - 8}" y="${y + 4}" class="viz-tick" text-anchor="end">${t}</text>`;
  }).join('');

  const bars = counts.map((c, i) => {
    const x = padL + band * i + (band - barW) / 2;
    const h = (c.value / max) * plotH;
    const y = padT + plotH - h;
    const isPeak = c.value === peak && peak > 0;
    const label = isPeak
      ? `<text x="${x + barW / 2}" y="${y - 7}" class="viz-value" text-anchor="middle">${c.value}</text>`
      : '';
    return `
      ${c.value > 0 ? `<path d="${columnPath(x, y, barW, h)}" fill="${VIZ.primary}" />` : ''}
      ${label}
      <rect x="${padL + band * i}" y="${padT}" width="${band}" height="${plotH}" fill="transparent"
            data-tip="${esc(cornerLabel(c.corner))} · ${c.camera}|${c.value} incident${c.value === 1 ? '' : 's'}" />
      <text x="${padL + band * i + band / 2}" y="${H - padB + 20}" class="viz-axis" text-anchor="middle">${c.label}</text>`;
  }).join('');

  const svg = `<svg viewBox="0 0 ${W} ${H}" class="viz-svg" role="img" aria-label="Incidents by corner">
    ${gridlines}
    <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="${VIZ.axis}" stroke-width="1" />
    ${bars}
  </svg>`;

  return chartShell(svg, table);
}

// ------------------------------------------------------------
// 2. Review outcomes — part-to-whole + the precision headline
// ------------------------------------------------------------

function renderOutcomesChart(records) {
  const byDecision = (d) => records.filter((r) => r.decision === d).length;
  const penalty = byDecision('Penalty');
  const noPenalty = byDecision('No Penalty');
  const noAction = byDecision('No Action');
  const pending = byDecision('Pending');

  const upheld = penalty + noPenalty;
  const reviewed = upheld + noAction;
  const total = upheld + noAction + pending;

  const table = chartTable(
    ['Outcome', 'Incidents', 'Share'],
    [
      ['<span class="decision-tag Penalty">Penalty</span>', penalty, total ? `${Math.round(penalty / total * 100)}%` : '—'],
      ['<span class="decision-tag No-Penalty">No Penalty</span>', noPenalty, total ? `${Math.round(noPenalty / total * 100)}%` : '—'],
      ['<span class="decision-tag No-Action">No Action</span>', noAction, total ? `${Math.round(noAction / total * 100)}%` : '—'],
      ['<span class="decision-tag Pending">Pending</span>', pending, total ? `${Math.round(pending / total * 100)}%` : '—'],
      ['<strong>Total</strong>', `<strong>${total}</strong>`, ''],
    ],
  );

  if (total === 0) {
    return chartShell(emptyState('No incidents in the current scope.'), table);
  }

  const segments = [
    { key: 'Upheld', value: upheld, colour: VIZ.upheld },
    { key: 'Rejected', value: noAction, colour: VIZ.rejected },
    { key: 'Pending', value: pending, colour: VIZ.pending },
  ].filter((s) => s.value > 0);

  const W = 620, barY = 16, barH = 30, padX = 2, gap = 2;
  const trackW = W - padX * 2;
  let cursor = padX;
  const marks = segments.map((s, i) => {
    const raw = (s.value / total) * trackW;
    const w = Math.max(4, raw - (i < segments.length - 1 ? gap : 0));
    const x = cursor;
    cursor += raw;
    const first = i === 0;
    const last = i === segments.length - 1;
    const r = 6;
    // rounded on the outer ends of the whole track only
    const d = `M${x + (first ? r : 0)},${barY}
      L${x + w - (last ? r : 0)},${barY}
      ${last ? `Q${x + w},${barY} ${x + w},${barY + r}` : ''}
      L${x + w},${barY + barH - (last ? r : 0)}
      ${last ? `Q${x + w},${barY + barH} ${x + w - r},${barY + barH}` : ''}
      L${x + (first ? r : 0)},${barY + barH}
      ${first ? `Q${x},${barY + barH} ${x},${barY + barH - r}` : ''}
      L${x},${barY + (first ? r : 0)}
      ${first ? `Q${x},${barY} ${x + r},${barY}` : ''} Z`;
    const pct = Math.round((s.value / total) * 100);
    const fits = w > 58;
    const inner = fits
      ? `<text x="${x + w / 2}" y="${barY + barH / 2 + 4}" class="viz-inbar" text-anchor="middle">${pct}%</text>`
      : '';
    return `<path d="${d.replace(/\s+/g, ' ')}" fill="${s.colour}" data-tip="${esc(s.key)}|${s.value} of ${total} · ${pct}%" />${inner}`;
  }).join('');

  const precision = reviewed > 0 ? Math.round((upheld / reviewed) * 100) : null;

  const hero = `
    <div class="viz-hero">
      <span class="viz-hero-value">${precision == null ? '—' : `${precision}%`}</span>
      <span class="viz-hero-label">of reviewed detections upheld</span>
      <span class="viz-hero-note">${reviewed} reviewed &middot; ${pending} still pending</span>
    </div>`;

  const svg = `<svg viewBox="0 0 ${W} ${barY + barH + 10}" class="viz-svg viz-svg-bar" role="img" aria-label="Review outcomes">${marks}</svg>`;

  const visual = hero + svg + legendRow([
    { label: `Upheld (${upheld})`, colour: VIZ.upheld },
    { label: `Rejected (${noAction})`, colour: VIZ.rejected },
    { label: `Pending (${pending})`, colour: VIZ.pending },
  ]);

  return chartShell(visual, table);
}

// ------------------------------------------------------------
// 3. Corner heatmap — sequential magnitude on the circuit map
// ------------------------------------------------------------

function catmullRomClosed(points, tension = 0.11) {
  if (points.length < 3) return '';
  const n = points.length;
  const at = (i) => points[(i + n) % n];
  let d = `M${at(0).x},${at(0).y}`;
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const c1x = p1.x + (p2.x - p0.x) * tension;
    const c1y = p1.y + (p2.y - p0.y) * tension;
    const c2x = p2.x - (p3.x - p1.x) * tension;
    const c2y = p2.y - (p3.y - p1.y) * tension;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x},${p2.y}`;
  }
  return `${d} Z`;
}

function renderHeatmap(records) {
  const corners = [...analysisLoops].sort((a, b) => a.corner - b.corner);
  const counts = corners.map((loop) => ({
    loop,
    value: records.filter((r) => r.corner === loop.corner).length,
  }));

  const table = chartTable(
    ['Corner', 'Camera', 'Marshalling post', 'Incidents'],
    counts.map((c) => [cornerLabel(c.loop.corner), c.loop.camera, c.loop.marshalling_post || '—', c.value]),
  );

  if (corners.length === 0) {
    return chartShell(emptyState('Circuit map unavailable.'), table);
  }

  const max = Math.max(1, ...counts.map((c) => c.value));
  const points = corners.map((l) => ({ x: l.layout ? l.layout.x : 0, y: l.layout ? l.layout.y : 0 }));
  const trackPath = catmullRomClosed(points);

  const step = (value) => {
    if (value === 0) return HEAT_RAMP[0];
    const idx = Math.ceil((value / max) * (HEAT_RAMP.length - 1));
    return HEAT_RAMP[Math.max(1, Math.min(HEAT_RAMP.length - 1, idx))];
  };

  // Push each corner label radially outward from the centre of the loop so
  // it never lands on the track itself.
  const cx = points.reduce((a, p) => a + p.x, 0) / points.length;
  const cy = points.reduce((a, p) => a + p.y, 0) / points.length;

  const nodes = counts.map(({ loop, value }) => {
    const { x, y } = loop.layout || { x: 0, y: 0 };
    const r = 12 + (value / max) * 14;
    const fill = step(value);
    // label ink flips with the fill so it always clears contrast
    const dark = value / max > 0.55;

    const vx = x - cx;
    const vy = y - cy;
    const len = Math.hypot(vx, vy) || 1;
    const lx = x + (vx / len) * (r + 14);
    const ly = y + (vy / len) * (r + 14) + 4;
    const anchor = vx / len > 0.35 ? 'start' : (vx / len < -0.35 ? 'end' : 'middle');

    return `
      <circle cx="${x}" cy="${y}" r="${r.toFixed(1)}" fill="${fill}" stroke="${VIZ.surface}" stroke-width="2"
              data-tip="${esc(cornerLabel(loop.corner))} · ${loop.camera}|${value} incident${value === 1 ? '' : 's'}" />
      <text x="${x}" y="${y + 4}" class="viz-node-label" text-anchor="middle"
            fill="${dark ? '#FFFFFF' : VIZ.ink}">${value}</text>
      <text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" class="viz-axis" text-anchor="${anchor}">${cornerShort(loop.corner)}</text>`;
  }).join('');

  const legendSteps = HEAT_RAMP.map((c, i) => `
    <span class="ramp-step" style="background:${c}" title="${i === 0 ? '0' : ''}"></span>`).join('');

  const svg = `<svg viewBox="0 0 620 320" class="viz-svg" role="img" aria-label="Corner heatmap">
    <path d="${trackPath}" fill="none" stroke="${VIZ.track}" stroke-width="10" stroke-linejoin="round" />
    <path d="${trackPath}" fill="none" stroke="${VIZ.surface}" stroke-width="2" stroke-dasharray="1 14" stroke-linecap="round" />
    ${nodes}
  </svg>`;

  const ramp = `<div class="chart-ramp">
      <span class="text-muted-label">fewer</span>
      <span class="ramp-strip">${legendSteps}</span>
      <span class="text-muted-label">more (max ${max})</span>
    </div>`;

  return chartShell(svg + ramp, table);
}

// ------------------------------------------------------------
// 4. Incidents over time — histogram across the clip timeline
// ------------------------------------------------------------

function renderTimelineChart(records) {
  const bins = Array.from({ length: TIMELINE_BINS }, (_, i) => ({
    from: i * TIMELINE_BIN_FRAMES,
    to: (i + 1) * TIMELINE_BIN_FRAMES,
    value: 0,
  }));

  for (const r of records) {
    const idx = Math.min(TIMELINE_BINS - 1, Math.max(0, Math.floor(r.startFrame / TIMELINE_BIN_FRAMES)));
    bins[idx].value += 1;
  }

  const table = chartTable(
    ['Session time', 'Frames', 'Incidents'],
    bins.map((b) => [`${formatClock(b.from)}–${formatClock(b.to)}`, `${b.from}–${b.to}`, b.value]),
  );

  if (records.length === 0) {
    return chartShell(emptyState('No incidents in the current scope.'), table);
  }

  const W = 620, H = 236;
  const padL = 36, padR = 14, padT = 20, padB = 38;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const { ticks, max } = niceTicks(Math.max(...bins.map((b) => b.value)));
  const band = plotW / bins.length;
  const barW = Math.min(24, band - 4);
  const peak = Math.max(...bins.map((b) => b.value));

  const gridlines = ticks.map((t) => {
    const y = padT + plotH - (t / max) * plotH;
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${VIZ.grid}" stroke-width="1" />
            <text x="${padL - 8}" y="${y + 4}" class="viz-tick" text-anchor="end">${t}</text>`;
  }).join('');

  const bars = bins.map((b, i) => {
    const x = padL + band * i + (band - barW) / 2;
    const h = (b.value / max) * plotH;
    const y = padT + plotH - h;
    const isPeak = b.value === peak && peak > 0;
    const tickLabel = i % 2 === 0
      ? `<text x="${padL + band * i + band / 2}" y="${H - padB + 20}" class="viz-axis" text-anchor="middle">${formatClock(b.from)}</text>`
      : '';
    return `
      ${b.value > 0 ? `<path d="${columnPath(x, y, barW, h)}" fill="${VIZ.primary}" />` : ''}
      ${isPeak ? `<text x="${x + barW / 2}" y="${y - 7}" class="viz-value" text-anchor="middle">${b.value}</text>` : ''}
      <rect x="${padL + band * i}" y="${padT}" width="${band}" height="${plotH}" fill="transparent"
            data-tip="${formatClock(b.from)}–${formatClock(b.to)}|${b.value} incident${b.value === 1 ? '' : 's'}" />
      ${tickLabel}`;
  }).join('');

  const svg = `<svg viewBox="0 0 ${W} ${H}" class="viz-svg" role="img" aria-label="Incidents over time">
    ${gridlines}
    <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="${VIZ.axis}" stroke-width="1" />
    ${bars}
  </svg>`;

  return chartShell(svg, table);
}

// ------------------------------------------------------------
// 5. Incidents per driver — ranked table
// ------------------------------------------------------------

function renderDriversTable(sessionRecords, allRecords) {
  const rows = new Map();

  const bucket = (rec) => {
    if (!rec.car) return null;
    const key = rec.car.number;
    if (!rows.has(key)) {
      rows.set(key, {
        car: rec.car,
        session: 0,
        season: 0,
        penalties: 0,
        corners: new Set(),
      });
    }
    return rows.get(key);
  };

  for (const rec of allRecords) {
    const row = bucket(rec);
    if (row) row.season += 1;
  }
  for (const rec of sessionRecords) {
    const row = bucket(rec);
    if (!row) continue;
    row.session += 1;
    if (rec.decision === 'Penalty') row.penalties += 1;
    if (rec.corner) row.corners.add(rec.corner);
  }

  const all = [...rows.values()]
    .filter((r) => r.session > 0 || r.season > 0)
    .sort((a, b) => b.session - a.session || b.season - a.season || a.car.number - b.car.number);

  // This session's offenders always show; the season tail is trimmed so the
  // ranking stays readable rather than listing the whole grid at zero.
  const inSession = all.filter((r) => r.session > 0);
  const ranked = all.slice(0, Math.max(inSession.length, Math.min(all.length, 10)));
  const hidden = all.length - ranked.length;

  const countEl = document.getElementById('drivers-count');
  if (countEl) {
    const n = inSession.length;
    countEl.textContent = `${n} driver${n === 1 ? '' : 's'} this session`;
  }

  if (ranked.length === 0) {
    return emptyState('No identified cars in the current scope.');
  }

  const maxSeason = Math.max(1, ...all.map((r) => r.season));

  const body = ranked.map((r, i) => {
    const corners = [...r.corners].sort((a, b) => a - b).map(cornerShort).join(', ') || '—';
    const barW = Math.round((r.season / maxSeason) * 100);
    return `<tr${r.session > 0 ? '' : ' class="row-muted"'}>
      <td class="rank-cell">${i + 1}</td>
      <td class="driver-cell">${carChipHTML(r.car)}</td>
      <td class="num-cell">${r.session}</td>
      <td class="num-cell">${r.penalties}</td>
      <td class="corner-cell">${esc(corners)}</td>
      <td class="season-cell">
        <span class="mini-bar" style="width:${barW}%"></span>
        <span class="mini-bar-value">${r.season}</span>
      </td>
    </tr>`;
  }).join('');

  const footnote = hidden > 0
    ? `<p class="text-muted-label chart-footnote">${hidden} more driver${hidden === 1 ? '' : 's'} with season violations but none this session</p>`
    : '';

  return `<div class="chart-table-scroll"><table class="chart-table drivers-table">
    <thead><tr>
      <th>#</th><th>Driver</th><th>This session</th><th>Penalties</th><th>Corners</th><th>Season total</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table></div>${footnote}`;
}

// ------------------------------------------------------------
// 6. Time to decision — stat tiles + per-incident bars
// ------------------------------------------------------------

function renderReviewTimeChart(records) {
  const timed = records
    .filter((r) => r.reviewSeconds != null)
    .sort((a, b) => b.reviewSeconds - a.reviewSeconds);

  const table = chartTable(
    ['Driver', 'Round', 'Corner', 'Outcome', 'Time to decision'],
    timed.map((r) => [
      esc(r.car ? `#${r.car.number} ${r.car.driver}` : 'Unidentified'),
      esc(r.sessionLabel),
      esc(cornerLabel(r.corner)),
      esc(r.decision),
      formatDuration(r.reviewSeconds),
    ]),
  );

  if (timed.length === 0) {
    return chartShell(
      emptyState('No incidents have been ruled on yet — decide one in Review Timeline.'),
      table,
    );
  }

  const values = timed.map((r) => r.reviewSeconds);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

  const tiles = `<div class="stat-row">
    <div class="stat-tile">
      <span class="stat-label">Average</span>
      <span class="stat-value">${formatDuration(mean)}</span>
      <span class="stat-note">across ${timed.length} decision${timed.length === 1 ? '' : 's'}</span>
    </div>
    <div class="stat-tile">
      <span class="stat-label">Median</span>
      <span class="stat-value">${formatDuration(median)}</span>
      <span class="stat-note">typical turnaround</span>
    </div>
    <div class="stat-tile">
      <span class="stat-label">Longest</span>
      <span class="stat-value">${formatDuration(sorted[sorted.length - 1])}</span>
      <span class="stat-note">${esc(timed[0].car ? timed[0].car.driver : 'Unidentified')} · ${esc(cornerLabel(timed[0].corner))}</span>
    </div>
  </div>`;

  const shown = timed.slice(0, 8);
  const listLabel = `<p class="text-muted-label chart-list-label">Slowest ${shown.length} decision${shown.length === 1 ? '' : 's'}</p>`;
  const max = Math.max(...shown.map((r) => r.reviewSeconds), 1);
  const bars = shown.map((r) => {
    const pct = Math.max(3, (r.reviewSeconds / max) * 100);
    const who = r.car ? `#${r.car.number} ${r.car.code || r.car.driver}` : 'Unidentified';
    return `<div class="hbar-row" data-tip="${esc(who)} · ${esc(cornerLabel(r.corner))}|${formatDuration(r.reviewSeconds)} · ${esc(r.decision)}">
      <span class="hbar-label">${esc(who)}<span class="hbar-sub">${esc(r.sessionLabel)} · ${cornerShort(r.corner)}</span></span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${pct}%"></span></span>
      <span class="hbar-value">${formatDuration(r.reviewSeconds)}</span>
    </div>`;
  }).join('');

  const more = timed.length > shown.length
    ? `<p class="text-muted-label chart-footnote">${timed.length - shown.length} more in the table view</p>`
    : '';

  return chartShell(`${tiles}${listLabel}<div class="hbar-list">${bars}</div>${more}`, table);
}

// ------------------------------------------------------------
// 7. Driver trend across rounds — small multiples
// ------------------------------------------------------------

function renderTrendChart(allRecords) {
  const rounds = [...new Set(allRecords.map((r) => r.round))].sort((a, b) => a - b);
  const byDriver = new Map();

  for (const rec of allRecords) {
    if (!rec.car) continue;
    if (!byDriver.has(rec.car.number)) {
      byDriver.set(rec.car.number, { car: rec.car, counts: new Map(), total: 0, current: 0 });
    }
    const d = byDriver.get(rec.car.number);
    d.counts.set(rec.round, (d.counts.get(rec.round) || 0) + 1);
    d.total += 1;
    if (rec.current) d.current += 1;
  }

  const drivers = [...byDriver.values()]
    .sort((a, b) => b.current - a.current || b.total - a.total)
    .slice(0, 6);

  const table = chartTable(
    ['Driver', ...rounds.map((r) => `R${r}`), 'Total'],
    [...byDriver.values()]
      .sort((a, b) => b.total - a.total)
      .map((d) => [
        esc(`#${d.car.number} ${d.car.driver}`),
        ...rounds.map((r) => d.counts.get(r) || 0),
        `<strong>${d.total}</strong>`,
      ]),
  );

  if (rounds.length < 2 || drivers.length === 0) {
    return chartShell(emptyState('Not enough archived rounds in the current scope to show a trend.'), table);
  }

  const max = Math.max(1, ...drivers.flatMap((d) => rounds.map((r) => d.counts.get(r) || 0)));
  const W = 260, H = 74, padX = 10, padT = 10, padB = 16;
  const plotH = H - padT - padB;
  const stepX = (W - padX * 2) / Math.max(1, rounds.length - 1);

  const panels = drivers.map((d) => {
    const pts = rounds.map((r, i) => ({
      x: padX + stepX * i,
      y: padT + plotH - ((d.counts.get(r) || 0) / max) * plotH,
      value: d.counts.get(r) || 0,
      round: r,
    }));
    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const last = pts[pts.length - 1];
    const hits = pts.map((p) => `
      <rect x="${p.x - stepX / 2}" y="${padT}" width="${stepX}" height="${plotH}" fill="transparent"
            data-tip="${esc(d.car.driver)} · R${p.round}|${p.value} violation${p.value === 1 ? '' : 's'}" />`).join('');

    return `<div class="trend-panel">
      <div class="trend-panel-head">
        <span class="trend-swatch" style="background:${d.car.teamColour}"></span>
        <span class="trend-name">#${d.car.number} ${esc(d.car.driver)}</span>
        <span class="trend-total">${d.total} this season</span>
      </div>
      <svg viewBox="0 0 ${W} ${H}" class="viz-svg trend-svg" role="img"
           aria-label="${esc(d.car.driver)} violations per round">
        <line x1="${padX}" y1="${padT + plotH}" x2="${W - padX}" y2="${padT + plotH}"
              stroke="${VIZ.grid}" stroke-width="1" />
        <path d="${line}" fill="none" stroke="${VIZ.primary}" stroke-width="2"
              stroke-linejoin="round" stroke-linecap="round" />
        <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="4"
                fill="${VIZ.primary}" stroke="${VIZ.surface}" stroke-width="2" />
        <text x="${(last.x - 8).toFixed(1)}" y="${(last.y - 9).toFixed(1)}" class="viz-value" text-anchor="end">${last.value}</text>
        ${hits}
      </svg>
      <div class="trend-axis">${rounds.map((r) => `<span>R${r}</span>`).join('')}</div>
    </div>`;
  }).join('');

  return chartShell(`<div class="trend-grid">${panels}</div>`, table);
}

// ------------------------------------------------------------
// Orchestration
// ------------------------------------------------------------

async function renderAnalysis() {
  if (!analysisDataReady) {
    await loadAnalysisData();
  }
  buildAnalysisFilters();

  const sessionAll = currentSessionRecords();
  const archivedAll = archivedRecords();

  const sessionRecords = applyFilters(sessionAll);
  const allRecords = applyFilters([...archivedAll, ...sessionAll]);

  const note = document.getElementById('analysis-scope-note');
  if (note) {
    const rounds = [...new Set(allRecords.map((r) => r.round))].length;
    note.textContent = `${sessionRecords.length} this session · ${allRecords.length} across ${rounds} round${rounds === 1 ? '' : 's'}`;
  }

  setChart('chart-corner', renderCornerChart(sessionRecords));
  setChart('chart-outcomes', renderOutcomesChart(sessionRecords));
  setChart('chart-heatmap', renderHeatmap(allRecords));
  setChart('chart-timeline', renderTimelineChart(sessionRecords));
  setChart('chart-drivers', renderDriversTable(sessionRecords, allRecords));
  setChart('chart-reviewtime', renderReviewTimeChart(allRecords));
  setChart('chart-trend', renderTrendChart(allRecords));
}

function setChart(id, html) {
  const el = document.getElementById(id);
  if (!el) return;
  const wasTable = el.dataset.view === 'table';
  el.innerHTML = html;
  if (wasTable) applyChartView(el, 'table');
}

function applyChartView(body, view) {
  const visual = body.querySelector('.chart-visual');
  const table = body.querySelector('.chart-table-wrap');
  if (!visual || !table) return;
  body.dataset.view = view;
  visual.hidden = view === 'table';
  table.hidden = view !== 'table';
}

document.querySelectorAll('.chart-view-toggle').forEach((btn) => {
  btn.addEventListener('click', () => {
    const body = document.getElementById(btn.dataset.target);
    if (!body || !body.querySelector('.chart-table-wrap')) return;
    const next = body.dataset.view === 'table' ? 'chart' : 'table';
    applyChartView(body, next);
    btn.textContent = next === 'table' ? 'Chart' : 'Table';
  });
});

// ------------------------------------------------------------
// Shared hover tooltip — every mark carrying data-tip gets one
// ------------------------------------------------------------

const chartTooltipEl = document.getElementById('chart-tooltip');
const analysisScreen = document.getElementById('section-analysis');

if (analysisScreen && chartTooltipEl) {
  analysisScreen.addEventListener('mousemove', (e) => {
    const mark = e.target.closest('[data-tip]');
    if (!mark) {
      chartTooltipEl.hidden = true;
      return;
    }
    const [title, value] = String(mark.dataset.tip).split('|');
    chartTooltipEl.innerHTML = `<span class="tip-title">${esc(title)}</span><span class="tip-value">${esc(value || '')}</span>`;
    chartTooltipEl.hidden = false;

    const bounds = analysisScreen.getBoundingClientRect();
    const x = e.clientX - bounds.left + 14;
    const y = e.clientY - bounds.top + 14;
    chartTooltipEl.style.left = `${Math.min(x, bounds.width - chartTooltipEl.offsetWidth - 8)}px`;
    chartTooltipEl.style.top = `${y}px`;
  });

  analysisScreen.addEventListener('mouseleave', () => { chartTooltipEl.hidden = true; });
}
