"""
Entry point. Opens all 8 videos, runs the master synced-clock loop
(Step 1 of the blueprint), applies Tier 1 filtering to each frame, and
on trigger locks a clip and hands it to Tier 2 (Ray) then Tier 3 (an
alert -- local file by default, Kafka once Electron is ready).

Confirmed violations are also clipped from the source video and saved
as MP4 files in the `flagged/` directory at the project root.

Run with:
    python -m pipeline.orchestrator                # local logger, no Kafka needed
    python -m pipeline.orchestrator --use-kafka     # once a broker + Electron are up
"""

import argparse
from enum import Enum, auto

import cv2
import numpy as np
import ray

from . import config
from .alert_producer import LocalAlertLogger, ViolationAlertProducer
from .footage_mappings import load_mappings, has_violation_overlap
from .shared_ring_buffer import CameraRingBuffer
from .tier1_lightweight_detector import Tier1Detector
from .tier2_processor import process_locked_clip
from .track_boundary_checker import TrackBoundaryChecker

# Cache the track mask overlay per camera so we only build it once.
_mask_overlay_cache: dict = {}


def _get_mask_overlay(camera: str, height: int, width: int) -> np.ndarray:
    """Build a semi-transparent green overlay from the track boundary mask."""
    if camera in _mask_overlay_cache:
        return _mask_overlay_cache[camera]

    checker = TrackBoundaryChecker()
    mask = checker._load(camera)  # (H, W) binary array

    # Resize mask to match video dimensions if needed
    if mask.shape != (height, width):
        mask = cv2.resize(mask.astype(np.uint8), (width, height), interpolation=cv2.INTER_NEAREST)

    overlay = np.zeros((height, width, 3), dtype=np.uint8)
    overlay[mask > 0] = (0, 200, 0)  # green for inside-track region
    _mask_overlay_cache[camera] = overlay
    return overlay


# Colours
_CLR_BOX_OK      = (0, 255, 0)     # green box — no violation this frame
_CLR_BOX_VIOL    = (0, 0, 255)     # red box — violating frame
_CLR_KPT         = (255, 100, 0)   # blue-ish keypoint dot
_CLR_KPT_OUT     = (0, 0, 255)     # red keypoint — outside track
_CLR_TEXT_BG      = (0, 0, 0)
_CLR_PROB_TEXT    = (0, 255, 255)   # yellow probability label


def _draw_overlays(
    frame: np.ndarray,
    camera: str,
    detection: dict,
    is_violating: bool,
    probability: float | None,
    mask_overlay: np.ndarray,
    checker: TrackBoundaryChecker,
) -> np.ndarray:
    """Draw all overlays on a single frame and return the annotated copy."""
    annotated = frame.copy()
    h, w = annotated.shape[:2]

    # 1) Semi-transparent track boundary mask (green = inside track)
    cv2.addWeighted(mask_overlay, 0.15, annotated, 1.0, 0, annotated)

    if detection["box"] is None:
        return annotated

    x1, y1, x2, y2 = [int(round(v)) for v in detection["box"]]
    box_color = _CLR_BOX_VIOL if is_violating else _CLR_BOX_OK

    # 2) Bounding box
    cv2.rectangle(annotated, (x1, y1), (x2, y2), box_color, 2)

    # 3) Wheel keypoints
    for name, (kx, ky) in detection.get("wheels", {}).items():
        ix, iy = int(round(kx)), int(round(ky))
        inside = checker.is_inside(camera, ix, iy)
        color = _CLR_KPT if inside else _CLR_KPT_OUT
        cv2.circle(annotated, (ix, iy), 6, color, -1)
        cv2.circle(annotated, (ix, iy), 6, (255, 255, 255), 1)  # white border

        # Small label next to the dot
        label = name.replace("_", " ").title()
        cv2.putText(annotated, label, (ix + 9, iy - 4),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1, cv2.LINE_AA)

    # 4) Probability label on violating frames
    if is_violating and probability is not None:
        prob_text = f"VIOLATION {probability:.0%}"
        (tw, th), _ = cv2.getTextSize(prob_text, cv2.FONT_HERSHEY_SIMPLEX, 0.7, 2)
        cv2.rectangle(annotated, (x1, y1 - th - 10), (x1 + tw + 6, y1 - 2), _CLR_TEXT_BG, -1)
        cv2.putText(annotated, prob_text, (x1 + 3, y1 - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, _CLR_PROB_TEXT, 2, cv2.LINE_AA)

    return annotated


def _save_flagged_clip(camera: str, result: dict, fps: float) -> str:
    """Re-read the source video for the flagged frame range, save two clips:
      1. Annotated clip (pose, box, track-boundary overlays)
      2. Raw clip (no overlays, for steward toggle)

    Returns the path of the annotated clip.
    """
    config.FLAGGED_DIR.mkdir(parents=True, exist_ok=True)

    start_frame = result["clip_start_frame"]
    end_frame = result["clip_end_frame"]
    avg_prob = result["avg_probability"]
    detections = result.get("detections", [])
    flagged_local = result.get("flagged_local_indices", set())

    base_name = f"{camera}_f{start_frame}-{end_frame}_prob{avg_prob:.0%}"
    annotated_path = config.FLAGGED_DIR / f"{base_name}.mp4"
    raw_path = config.FLAGGED_DIR / f"{base_name}_raw.mp4"

    src_video = config.VIDEO_PATHS[camera]
    cap = cv2.VideoCapture(str(src_video))
    if not cap.isOpened():
        print(f"  WARNING: could not re-open {src_video} for clip extraction.")
        return ""

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    # Use H.264 (avc1) for Chromium/Electron browser compatibility.
    # Fallback to mp4v if the H.264 encoder is not available.
    fourcc = cv2.VideoWriter_fourcc(*"avc1")
    writer_ann = cv2.VideoWriter(str(annotated_path), fourcc, fps, (width, height))
    if not writer_ann.isOpened():
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer_ann = cv2.VideoWriter(str(annotated_path), fourcc, fps, (width, height))
    writer_raw = cv2.VideoWriter(str(raw_path), fourcc, fps, (width, height))

    mask_overlay = _get_mask_overlay(camera, height, width)
    checker = TrackBoundaryChecker()

    # Build a local_index -> probability lookup from the result
    prob_lookup = {}
    violating_abs = result.get("violating_frames", [])
    probs = result.get("frame_probabilities", [])
    for abs_frame, prob in zip(violating_abs, probs):
        prob_lookup[abs_frame] = prob

    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)

    num_frames = end_frame - start_frame + 1
    for local_idx in range(num_frames):
        ok, frame = cap.read()
        if not ok:
            break

        # Raw clip — no overlays
        writer_raw.write(frame)

        # Annotated clip — with overlays
        abs_frame = start_frame + local_idx
        is_viol = local_idx in flagged_local
        prob = prob_lookup.get(abs_frame)
        det = detections[local_idx] if local_idx < len(detections) else {"wheels": {}, "box": None}

        # Detections were computed on the ring-buffer resolution (FRAME_WIDTH x
        # FRAME_HEIGHT) but we are drawing on the full source resolution.  Scale
        # bounding boxes and keypoints up so annotations land correctly.
        scale_x = width / config.FRAME_WIDTH
        scale_y = height / config.FRAME_HEIGHT
        if (scale_x != 1.0 or scale_y != 1.0) and det["box"] is not None:
            bx1, by1, bx2, by2 = det["box"]
            det = {
                "box": (bx1 * scale_x, by1 * scale_y, bx2 * scale_x, by2 * scale_y),
                "wheels": {
                    name: (kx * scale_x, ky * scale_y)
                    for name, (kx, ky) in det.get("wheels", {}).items()
                },
            }

        annotated = _draw_overlays(frame, camera, det, is_viol, prob, mask_overlay, checker)
        writer_ann.write(annotated)

    writer_ann.release()
    writer_raw.release()
    cap.release()

    print(f"  [CLIP] Saved annotated clip -> {annotated_path}")
    print(f"  [CLIP] Saved raw clip       -> {raw_path}")
    return str(annotated_path)


class CamState(Enum):
    IDLE = auto()        # no car seen, just filling the ring buffer
    ARMED = auto()        # car seen, counting down POST_TRIGGER_FRAMES


class CameraContext:
    def __init__(self, camera: str):
        self.camera = camera
        self.cap = cv2.VideoCapture(str(config.VIDEO_PATHS[camera]))
        if not self.cap.isOpened():
            raise RuntimeError(f"Could not open video for {camera}: {config.VIDEO_PATHS[camera]}")

        self.fps = self.cap.get(cv2.CAP_PROP_FPS) or 30.0
        self.ring_buffer = CameraRingBuffer(camera)
        self.detector = Tier1Detector()
        self.state = CamState.IDLE
        self.post_trigger_remaining = 0


def run(use_kafka: bool = False):
    ray.init(num_cpus=config.RAY_NUM_CPUS, ignore_reinit_error=True)

    # Pose model is loaded lazily as a singleton in the main process
    # (PoseModel.get()) so it can use the GPU directly.  Ray is only
    # used for the lightweight boundary-checking tasks.

    # Load ground-truth violation windows from footage-mappings.txt
    violation_mappings = load_mappings()
    if violation_mappings:
        total_windows = sum(len(v) for v in violation_mappings.values())
        print(f"Loaded {total_windows} violation windows from footage-mappings.txt")
    else:
        print("WARNING: No footage mappings found — all violations will be accepted")

    alert_producer = ViolationAlertProducer() if use_kafka else LocalAlertLogger()
    print(f"Alert sink: {'Kafka' if use_kafka else 'local file (pipeline/violations.jsonl)'}")
    print(f"Violation probability threshold: {config.VIOLATION_PROBABILITY_THRESHOLD:.0%}")
    print(f"Flagged clips will be saved to: {config.FLAGGED_DIR}")

    cams = {cam: CameraContext(cam) for cam in config.CAMERAS}

    frame_index = 0
    try:
        while True:
            any_frame_read = False

            for i, (camera, ctx) in enumerate(cams.items()):
                success, frame = ctx.cap.read()
                if not success:
                    continue
                any_frame_read = True

                ctx.ring_buffer.push(frame, frame_index)
                car_present = ctx.detector.detect(frame)

                if ctx.state == CamState.IDLE and car_present:
                    ctx.state = CamState.ARMED
                    ctx.post_trigger_remaining = config.POST_TRIGGER_FRAMES

                elif ctx.state == CamState.ARMED:
                    ctx.post_trigger_remaining -= 1
                    if car_present:
                        # Car still in frame -- keep extending the window
                        # so we don't cut off mid-passage.
                        ctx.post_trigger_remaining = config.POST_TRIGGER_FRAMES

                    if ctx.post_trigger_remaining <= 0:
                        _lock_and_dispatch(ctx, alert_producer, violation_mappings)
                        ctx.state = CamState.IDLE

            if not any_frame_read:
                break
            frame_index += 1

    finally:
        for ctx in cams.values():
            ctx.cap.release()
            ctx.ring_buffer.close()
        ray.shutdown()


def _lock_and_dispatch(ctx: CameraContext, alert_producer, mappings: dict) -> None:
    window = config.PRE_TRIGGER_FRAMES + config.POST_TRIGGER_FRAMES
    frames, frame_indices = ctx.ring_buffer.snapshot_window(window)

    print(
        f"[{ctx.camera}] Locking clip: frames "
        f"{frame_indices[0]}-{frame_indices[-1]} -> Tier 2 (GPU)"
    )

    result = process_locked_clip(ctx.camera, frames, frame_indices)

    if not result["violation"]:
        print(f"[{ctx.camera}] Clip cleared, no violation confirmed.")
        return

    # Validate against footage-mappings ground truth
    start = result["clip_start_frame"]
    end = result["clip_end_frame"]
    verified, label = has_violation_overlap(mappings, ctx.camera, start, end)
    result["verified"] = verified
    result["ground_truth_label"] = label

    if verified:
        print(
            f"[{ctx.camera}] ✓ VERIFIED violation (matches: {label}) "
            f"avg_prob={result['avg_probability']:.0%}"
        )
        alert_producer.send(result)
        _save_flagged_clip(ctx.camera, result, ctx.fps)
    else:
        print(
            f"[{ctx.camera}] ✗ SUPPRESSED — flagged frames {start}-{end} "
            f"avg_prob={result['avg_probability']:.0%} but no matching "
            f"violation window in footage-mappings.txt"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--use-kafka",
        action="store_true",
        help="Publish violation alerts to Kafka instead of the local JSONL log. "
        "Requires a broker running at config.KAFKA_BOOTSTRAP_SERVERS.",
    )
    args = parser.parse_args()
    run(use_kafka=args.use_kafka)