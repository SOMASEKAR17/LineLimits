"""
Central configuration for the LineLimits real-time ML pipeline.

This ties together your two existing scripts:
  - models/pose-detection/video_pose.py       (Tier 2: pose / wheel keypoints)
  - models/track-segmentation/newewe.py       (Tier 2: static "inside" track masks)

Drop the `pipeline/` folder into the root of the `lineLimits` project,
as a sibling of `models/`, `real-life-footage/`, etc. (i.e. exactly
where this file already assumes it lives).
"""

from pathlib import Path

# lineLimits/  (parent of this pipeline/ folder)
ROOT_DIR = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------
# Cameras
# ---------------------------------------------------------------
CAMERAS = [f"CAM{i}" for i in range(1, 9)]

# Simulation runs stream the 8 pre-recorded 2-min clips in sync, as if
# they were live camera feeds. Switch to real-life-footage/ once you're
# pointing this at actual live/recorded race footage instead.
FOOTAGE_DIR = ROOT_DIR / "simulation-footage"

VIDEO_PATHS = {cam: FOOTAGE_DIR / f"CAM-{cam[3:]}.mp4" for cam in CAMERAS}

# ---------------------------------------------------------------
# Models (Tier 2)
# ---------------------------------------------------------------
# v4 (200-image dataset, color-only) is your confirmed-best checkpoint
# -- matches the default already used in video_pose.py.
POSE_WEIGHTS = ROOT_DIR / "models" / "pose-detection" / "weights" / "best_v4_full_color.pt"

TRACK_BOUNDARY_JSON = (
    ROOT_DIR / "models" / "track-segmentation" / "track_boundaries" / "static_track_boundaries.json"
)
MASK_DIR = ROOT_DIR / "models" / "track-segmentation" / "track_boundaries" / "masks"

# ---------------------------------------------------------------
# Ring buffer / two-tier filtering (Step 1 & 2 of the blueprint)
# ---------------------------------------------------------------
RING_BUFFER_FRAMES = 300      # depth of the rolling circular buffer per camera
PRE_TRIGGER_FRAMES = 100      # frames kept before a car is first seen
POST_TRIGGER_FRAMES = 200     # frames kept after a car is first seen

# Must match your actual video resolution -- get it from
# cv2.VideoCapture / get_video_info() in newewe.py if unsure.
FRAME_HEIGHT = 720
FRAME_WIDTH = 1280
FRAME_CHANNELS = 3

# ---------------------------------------------------------------
# Tier 1 - always-on lightweight detector
# ---------------------------------------------------------------
TIER1_DOWNSCALE = 0.25         # process at 25% resolution for speed
TIER1_MIN_CONTOUR_AREA = 400   # in downscaled px^2 -- tune per camera framing
TIER1_HISTORY = 500
TIER1_VAR_THRESHOLD = 32
TIER1_WARMUP_FRAMES = 60   # ~2 seconds at 30fps -- let MOG2 learn the static background first

# ---------------------------------------------------------------
# Tier 2 - Ray cluster
# ---------------------------------------------------------------
RAY_NUM_CPUS = 4
POSE_CONF_THRESHOLD = 0.3

# Index into the model's keypoint array corresponding to each wheel.
# Ultralytics pose models return keypoints in the order they were
# labeled during training -- update these to match best_v4's actual
# label order (check your data.yaml / Roboflow export / readme.md).
# Index into the model's keypoint array corresponding to each wheel.
# Confirmed against best_v4_full_color.pt via inspect_keypoints.py:
#   0 = front-right tyre   3 = rear-right tyre
#   1 = front-left tyre    4 = rear wing (not a wheel, unused here)
#   2 = rear-left tyre     5 = front wing (not a wheel, unused here)
WHEEL_KEYPOINT_INDICES = {
    "front_right": 0,
    "front_left": 1,
    "rear_left": 2,
    "rear_right": 3,
}

# ---------------------------------------------------------------
# Kafka (Step 4 - alert to Electron)
# ---------------------------------------------------------------
KAFKA_BOOTSTRAP_SERVERS = ["localhost:9092"]
KAFKA_TOPIC = "track-violations"

# ---------------------------------------------------------------
# Violation probability scoring
# ---------------------------------------------------------------
# Combined score = WHEEL_WEIGHT * (wheels_outside/4) + BOX_WEIGHT * (box_pixels_outside/box_total)
# Wheels are the core signal; the bounding-box overlap is supporting evidence.
VIOLATION_PROBABILITY_THRESHOLD = 0.80   # minimum combined probability to flag a violation
WHEEL_WEIGHT = 0.6                       # weight for the wheel-keypoint component
BOX_WEIGHT   = 0.4                       # weight for the bounding-box component

# ---------------------------------------------------------------
# Output
# ---------------------------------------------------------------
FLAGGED_DIR = ROOT_DIR / "flagged"