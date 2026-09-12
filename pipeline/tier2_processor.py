"""Tier 2 — GPU pose estimation + boundary checking.

The pose model runs in the MAIN process (not a Ray actor) so it can
directly access the RTX 4060 GPU.  Ray worker processes on Windows
cannot see CUDA devices, so we keep GPU inference local and only
offload the lightweight boundary-checking math to Ray.
"""

from typing import List, Tuple

import numpy as np
import ray

from . import config
from .track_boundary_checker import TrackBoundaryChecker


class PoseModel:
    """Singleton-ish wrapper around the YOLO pose model.  Lives in the
    main process so it can use the GPU directly."""

    _instance = None

    @classmethod
    def get(cls) -> "PoseModel":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def __init__(self, weights_path=config.POSE_WEIGHTS):
        from ultralytics import YOLO
        import torch

        self.model = YOLO(str(weights_path))

        if torch.cuda.is_available():
            self.device = 0
            print(f"[PoseModel] Using GPU: {torch.cuda.get_device_name(0)}")
        else:
            self.device = "cpu"
            print("[PoseModel] WARNING: CUDA not available, falling back to CPU")

    def extract_detections(self, frames: np.ndarray) -> List[dict]:
        """For each frame, return wheel keypoints and the bounding box.

        Returns a list (one dict per frame) with keys:
          - "wheels": dict mapping wheel name -> (x, y)
          - "box":    (x1, y1, x2, y2) or None
        """
        results = self.model.predict(
            source=list(frames),
            conf=config.POSE_CONF_THRESHOLD,
            device=self.device,
            verbose=False,
        )

        per_frame = []
        for result in results:
            detection = {"wheels": {}, "box": None}

            if result.boxes is not None and len(result.boxes) > 0:
                # Take the highest-confidence detection
                best_idx = int(result.boxes.conf.argmax())
                box = result.boxes.xyxy[best_idx].cpu().numpy()
                detection["box"] = tuple(float(v) for v in box)

                if result.keypoints is not None and best_idx < len(result.keypoints):
                    kpts = result.keypoints.xy[best_idx].cpu().numpy()
                    for name, idx in config.WHEEL_KEYPOINT_INDICES.items():
                        if idx < len(kpts):
                            detection["wheels"][name] = tuple(float(v) for v in kpts[idx])

            per_frame.append(detection)
        return per_frame


@ray.remote(num_cpus=1)
def check_boundary_violations(
    camera: str, per_frame_detections: List[dict]
) -> List[Tuple[int, float]]:
    """Return a list of (local_frame_index, probability) for every frame
    whose violation probability meets the config threshold."""
    checker = TrackBoundaryChecker()
    flagged: List[Tuple[int, float]] = []

    for i, det in enumerate(per_frame_detections):
        if not det["box"]:
            continue  # no detection at all -> skip

        wheel_points = list(det["wheels"].values()) if det["wheels"] else []
        prob = checker.violation_probability(camera, wheel_points, det["box"])

        if prob >= config.VIOLATION_PROBABILITY_THRESHOLD:
            flagged.append((i, prob))

    return flagged


def process_locked_clip(
    camera: str,
    frames: np.ndarray,
    frame_indices: np.ndarray,
) -> dict:
    # Pose inference runs in the main process -> GPU access guaranteed
    pose_model = PoseModel.get()
    per_frame_detections = pose_model.extract_detections(frames)

    # Boundary checking is CPU-only math -> offload to Ray
    flagged_ref = check_boundary_violations.remote(camera, per_frame_detections)
    flagged_pairs = ray.get(flagged_ref)  # list of (local_idx, probability)

    violating_frames = []
    probabilities = []
    for local_idx, prob in flagged_pairs:
        violating_frames.append(int(frame_indices[local_idx]))
        probabilities.append(prob)

    avg_probability = round(sum(probabilities) / len(probabilities), 4) if probabilities else 0.0

    return {
        "camera": camera,
        "violation": len(violating_frames) > 0,
        "violating_frames": violating_frames,
        "frame_probabilities": probabilities,
        "avg_probability": avg_probability,
        "clip_start_frame": int(frame_indices[0]),
        "clip_end_frame": int(frame_indices[-1]),
    }