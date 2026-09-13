"""Car identification for confirmed track-limit violations.

The vision pipeline knows *that* a car crossed the white line, and on which
camera, over which frames.  It does not know *which* car.  Race control
resolves that the same way the real timing system does: every marshalling
post has a transponder loop co-located with its camera, and each car carries
a transponder that the loop picks up as the car passes through its field.

`transponder_feed.jsonl` is the recorded loop output for the session -- one
dwell record per (loop, car) pass, with the frame window the car was inside
that loop's field and the peak RSSI of the read.  `session_entry_list.json`
is the scrutineered entry list mapping car numbers to drivers and teams.

Identification is therefore a correlation, not a lookup: take the violation's
camera and frame window, pull every loop read on that camera that overlaps
the window, and score each candidate on how much of the window it covers and
how strong the read was.  Weak edge reads from cars entering or leaving the
loop field score low and lose; the car actually sitting in front of the
camera wins.

Usage:
    from pipeline.car_identifier import CarIdentifier

    ident = CarIdentifier()
    car = ident.identify("CAM4", 911, 1210)
    # -> {'number': 6, 'driver': 'Isack Hadjar', 'team': '...', ...}
"""

import json
from pathlib import Path
from typing import Dict, List, Optional

from . import config

ENTRY_LIST_FILE = config.ROOT_DIR / "pipeline" / "session_entry_list.json"
TRANSPONDER_FEED_FILE = config.ROOT_DIR / "pipeline" / "transponder_feed.jsonl"

# RSSI range used to normalise read strength into 0..1.
RSSI_FLOOR_DBM = -95.0
RSSI_CEIL_DBM = -30.0

# How much each signal contributes to the match score.
W_COVERAGE = 0.75
W_SIGNAL = 0.25

# Below this score we refuse to name a car rather than guess.
MIN_ACCEPT_SCORE = 0.25


def _normalise_rssi(rssi_dbm: float) -> float:
    span = RSSI_CEIL_DBM - RSSI_FLOOR_DBM
    return max(0.0, min(1.0, (rssi_dbm - RSSI_FLOOR_DBM) / span))


def _cam_key(raw: str) -> str:
    digits = "".join(ch for ch in str(raw) if ch.isdigit())
    return f"CAM{int(digits)}" if digits else str(raw).upper()


class CarIdentifier:
    """Correlates a violation frame window against the transponder loop feed."""

    def __init__(
        self,
        entry_list_file: Path | None = None,
        feed_file: Path | None = None,
    ):
        self.entry_list_file = entry_list_file or ENTRY_LIST_FILE
        self.feed_file = feed_file or TRANSPONDER_FEED_FILE

        self.entries: Dict[int, dict] = {}
        self.loops: Dict[str, dict] = {}
        self.reads_by_camera: Dict[str, List[dict]] = {}

        self._load_entry_list()
        self._load_feed()

    # ------------------------------------------------------------------
    # loading
    # ------------------------------------------------------------------

    def _load_entry_list(self) -> None:
        if not self.entry_list_file.exists():
            print(f"[car_identifier] WARNING: {self.entry_list_file} not found")
            return

        data = json.loads(self.entry_list_file.read_text(encoding="utf-8"))
        for entry in data.get("entries", []):
            self.entries[int(entry["car"])] = entry
        for loop in data.get("loops", []):
            self.loops[_cam_key(loop["camera"])] = loop

    def _load_feed(self) -> None:
        if not self.feed_file.exists():
            print(f"[car_identifier] WARNING: {self.feed_file} not found")
            return

        with open(self.feed_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    read = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not read.get("valid", True):
                    continue
                cam = _cam_key(read.get("camera", ""))
                self.reads_by_camera.setdefault(cam, []).append(read)

    # ------------------------------------------------------------------
    # correlation
    # ------------------------------------------------------------------

    def candidates(self, camera: str, start_frame: int, end_frame: int) -> List[dict]:
        """Score every loop read on this camera that overlaps the window."""
        cam = _cam_key(camera)
        window = max(1, int(end_frame) - int(start_frame))
        scored = []

        for read in self.reads_by_camera.get(cam, []):
            overlap = min(read["exit_frame"], end_frame) - max(read["enter_frame"], start_frame)
            if overlap <= 0:
                continue

            coverage = min(1.0, overlap / window)
            signal = _normalise_rssi(read.get("peak_rssi_dbm", RSSI_FLOOR_DBM))
            score = W_COVERAGE * coverage + W_SIGNAL * signal

            scored.append({
                "car": int(read["car"]),
                "loop_id": read.get("loop_id", ""),
                "marshalling_post": read.get("marshalling_post", ""),
                "overlap_frames": int(overlap),
                "coverage": round(coverage, 4),
                "signal": round(signal, 4),
                "peak_rssi_dbm": read.get("peak_rssi_dbm"),
                "score": round(score, 4),
            })

        scored.sort(key=lambda c: c["score"], reverse=True)
        return scored

    def identify(self, camera: str, start_frame: int, end_frame: int) -> Optional[dict]:
        """Return the identity of the car in this violation window, or None."""
        ranked = self.candidates(camera, start_frame, end_frame)
        if not ranked:
            return None

        best = ranked[0]
        if best["score"] < MIN_ACCEPT_SCORE:
            return None

        runner_up = ranked[1]["score"] if len(ranked) > 1 else 0.0
        margin = best["score"] - runner_up

        entry = self.entries.get(best["car"])
        if entry is None:
            return None

        # Confidence blends how well the read covered the window with how
        # clearly it beat the next-best candidate on the same loop.
        confidence = min(0.999, best["score"] * (0.85 + 0.15 * min(1.0, margin / 0.5)))

        return {
            "number": entry["car"],
            "driver": entry["driver"],
            "code": entry.get("code", ""),
            "team": entry["team"],
            "teamShort": entry.get("team_short", entry["team"]),
            "teamColour": entry.get("colour", "#9CA3AF"),
            "transponder": entry.get("transponder", ""),
            "loopId": best["loop_id"],
            "marshallingPost": best["marshalling_post"],
            "coverage": best["coverage"],
            "peakRssiDbm": best["peak_rssi_dbm"],
            "confidence": round(confidence, 4),
            "contested": len(ranked) > 1,
            "method": "transponder-loop correlation",
        }


_DEFAULT: Optional[CarIdentifier] = None


def identify(camera: str, start_frame: int, end_frame: int) -> Optional[dict]:
    """Module-level convenience wrapper over a shared CarIdentifier."""
    global _DEFAULT
    if _DEFAULT is None:
        _DEFAULT = CarIdentifier()
    return _DEFAULT.identify(camera, start_frame, end_frame)


if __name__ == "__main__":
    ident = CarIdentifier()
    print("Loop reads per camera:")
    for cam, reads in sorted(ident.reads_by_camera.items()):
        print(f"  {cam}: {len(reads)} read(s)")

    print("\nSelf-test against the known violation windows:")
    for cam, start, end in [
        ("CAM3", 490, 807),
        ("CAM4", 911, 1210),
        ("CAM4", 2574, 3396),
        ("CAM5", 721, 1119),
        ("CAM7", 1431, 1730),
        ("CAM8", 1451, 2065),
    ]:
        car = ident.identify(cam, start, end)
        if car:
            print(
                f"  {cam} f{start}-{end} -> #{car['number']} {car['driver']} "
                f"({car['team']}) conf={car['confidence']:.0%} via {car['loopId']}"
            )
        else:
            print(f"  {cam} f{start}-{end} -> unidentified")
