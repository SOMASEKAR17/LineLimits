# lineLimits — Race Control Dashboard

An Electron shell for the track-limit violation dashboard, styled from `design.md`.
This is the **UI layer only** — it stands in for the shared-memory / Tier-1 / Tier-2 /
Kafka pipeline with a mock telemetry generator so you can build and demo the dashboard
before the backend exists.

## Run it

```bash
cd application
npm install
npm start
```

## How it's wired to your folders

`config.json` points at `../simulation-footage` and `../real-life-footage` (siblings of
`application/`, matching your `lineLimits` layout). On the start screen, picking a
source scans that folder for video files and pulls a camera number out of each
filename via `/cam[-_ ]?(\d+)/i` — the same convention `newewe.py` and `video_pose.py`
already use (`CAM-1.mp4`, `CAM_2.mov`, `cam3.mp4`, etc.). Nothing is hardcoded to a
specific filename, so it keeps working as you add/rename clips. Cameras that can't be
found show a "NO SIGNAL" tile instead of breaking the grid.

If your clips live somewhere else, just edit the `dir` values in `config.json`.

## What's real vs. mocked

- **Real:** window chrome, camera discovery, the synced 8-up video grid, the master
  play/pause/scrub transport, the telemetry log and alerts panel, and the Steward
  Review modal with a frame-accurate scrubber (assumes 30fps, matching the constant
  already used in `newewe.py`).
- **Mocked:** `main.js` → `generateMockEvent()` fabricates Tier-1/Tier-2/violation
  events every ~1.8s instead of reading them from shared memory or Kafka.

## Wiring in the real pipeline

`main.js` is deliberately the only place that knows about telemetry. It forwards
events to the renderer over IPC (`telemetry-event`) using this shape:

```js
{
  camera: "CAM3",
  type: "violation_confirmed", // tier1_clear | tier1_car_detected | tier2_processing | violation_confirmed
  frame: 1423,
  timestamp: "2026-09-12T10:00:00.000Z",
  frameRange: [1323, 1623] // only present on violation_confirmed
}
```

To go live: replace `startMockTelemetry()` in `main.js` with a real consumer (a
`kafkajs` or `ioredis` client is the natural fit, since that's the message broker
your architecture doc already calls for) that emits objects in this same shape via
`mainWindow.webContents.send('telemetry-event', event)`. Nothing in `renderer.js`
needs to change.

The shared-memory ring buffers, Tier-1 detector, and Ray cluster all live outside
this app entirely — this dashboard only ever needs the lightweight JSON alert, per
your Step 4 design ("do not compile a heavy MP4 file yet").

## Notes / assumptions made

- Videos are assumed to be ~2 minutes at 30fps (3600 frames), matching the "2 min
  synced MP4s" in your architecture note and the FPS constant in `newewe.py`. If your
  actual footage differs, adjust `ASSUMED_FPS` in `src/renderer.js`.
- The sync transport plays/pauses all 8 `<video>` elements together and scrubs them to
  the same timestamp; it doesn't attempt frame-perfect genlock, which isn't necessary
  for reviewing footage in the UI.
- Fonts (Playfair Display / Inter) are pulled from Google Fonts at runtime — swap in
  local font files in `src/styles.css` if you need this fully offline.
