"""
Re-generate the annotated flagged clips with correctly-scaled pose annotations.
This reads each source video for the flagged frame ranges, re-runs the pose model,
scales detections to the source resolution, and writes H.264 annotated clips.

The raw clips are left untouched since they don't have annotations.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import json
import cv2
import numpy as np

from pipeline import config
from pipeline.tier2_processor import PoseModel
from pipeline.track_boundary_checker import TrackBoundaryChecker
from pipeline.orchestrator import _draw_overlays, _get_mask_overlay

VIOLATIONS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pipeline", "violations.jsonl")

# Load violations
violations = []
with open(VIOLATIONS_FILE, "r") as f:
    for line in f:
        line = line.strip()
        if line:
            violations.append(json.loads(line))

print(f"Loaded {len(violations)} violations to re-annotate")

# Load pose model
pose_model = PoseModel()
checker = TrackBoundaryChecker()

for v in violations:
    camera = v["camera"]
    start_frame = v["clip_start_frame"]
    end_frame = v["clip_end_frame"]
    avg_prob = v["avg_probability"]
    violating_frames = set(v.get("violating_frames", []))
    frame_probs = v.get("frame_probabilities", [])
    violating_list = v.get("violating_frames", [])

    # Build prob lookup
    prob_lookup = {}
    for abs_frame, prob in zip(violating_list, frame_probs):
        prob_lookup[abs_frame] = prob

    # Build flagged local indices
    flagged_local = set()
    for abs_frame in violating_list:
        local_idx = abs_frame - start_frame
        if 0 <= local_idx:
            flagged_local.add(local_idx)

    base_name = f"{camera}_f{start_frame}-{end_frame}_prob{avg_prob:.0%}"
    annotated_path = config.FLAGGED_DIR / f"{base_name}.mp4"

    src_video = config.VIDEO_PATHS[camera]
    cap = cv2.VideoCapture(str(src_video))
    if not cap.isOpened():
        print(f"  SKIP: cannot open {src_video}")
        continue

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    print(f"\n  Re-annotating {base_name}.mp4")
    print(f"    Source: {src_w}x{src_h}, Processing: {config.FRAME_WIDTH}x{config.FRAME_HEIGHT}")
    print(f"    Scale factors: x={src_w/config.FRAME_WIDTH:.2f}, y={src_h/config.FRAME_HEIGHT:.2f}")

    # Read all frames in the range
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    num_frames = end_frame - start_frame + 1
    source_frames = []
    process_frames = []  # Downscaled for pose model

    for i in range(num_frames):
        ok, frame = cap.read()
        if not ok:
            break
        source_frames.append(frame)
        # Downscale to processing resolution for the pose model
        small = cv2.resize(frame, (config.FRAME_WIDTH, config.FRAME_HEIGHT))
        process_frames.append(small)

    cap.release()
    print(f"    Read {len(source_frames)} frames")

    # Run pose model on downscaled frames (batch)
    batch_size = 16
    all_detections = []
    for batch_start in range(0, len(process_frames), batch_size):
        batch = np.array(process_frames[batch_start:batch_start+batch_size])
        dets = pose_model.extract_detections(batch)
        all_detections.extend(dets)
    print(f"    Got {len(all_detections)} detections")

    # Prepare the mask overlay at source resolution
    mask_overlay = _get_mask_overlay(camera, src_h, src_w)

    # Scale factors from processing to source resolution
    scale_x = src_w / config.FRAME_WIDTH
    scale_y = src_h / config.FRAME_HEIGHT

    # Write annotated clip
    fourcc = cv2.VideoWriter_fourcc(*"avc1")
    writer = cv2.VideoWriter(str(annotated_path), fourcc, fps, (src_w, src_h))
    if not writer.isOpened():
        # Fallback
        fourcc = cv2.VideoWriter_fourcc(*"X264")
        writer = cv2.VideoWriter(str(annotated_path), fourcc, fps, (src_w, src_h))
    if not writer.isOpened():
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(str(annotated_path), fourcc, fps, (src_w, src_h))

    for local_idx, frame in enumerate(source_frames):
        abs_frame = start_frame + local_idx
        is_viol = local_idx in flagged_local
        prob = prob_lookup.get(abs_frame)
        det = all_detections[local_idx] if local_idx < len(all_detections) else {"wheels": {}, "box": None}

        # Scale detections from processing resolution to source resolution
        if det["box"] is not None and (scale_x != 1.0 or scale_y != 1.0):
            bx1, by1, bx2, by2 = det["box"]
            det = {
                "box": (bx1 * scale_x, by1 * scale_y, bx2 * scale_x, by2 * scale_y),
                "wheels": {
                    name: (kx * scale_x, ky * scale_y)
                    for name, (kx, ky) in det.get("wheels", {}).items()
                },
            }

        annotated = _draw_overlays(frame, camera, det, is_viol, prob, mask_overlay, checker)
        writer.write(annotated)

    writer.release()

    # Verify codec
    test_cap = cv2.VideoCapture(str(annotated_path))
    fourcc_int = int(test_cap.get(cv2.CAP_PROP_FOURCC))
    codec = chr(fourcc_int & 0xFF) + chr((fourcc_int >> 8) & 0xFF) + chr((fourcc_int >> 16) & 0xFF) + chr((fourcc_int >> 24) & 0xFF)
    test_cap.release()
    print(f"    Saved: {annotated_path} (codec: {codec})")

print("\nDone! Annotated clips have been re-generated with correct pose scaling.")
