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

# Point this at real-life-footage/ or simulation-footage/ depending on
# which run you're doing. video_pose.py's --source-dir shows the same
# naming convention (CAM-1.mp4 .. CAM-8.mp4).
FOOTAGE_DIR = ROOT_DIR / "real-life-footage"

VIDEO_PATHS = {cam: FOOTAGE_DIR / f"CAM-{cam[3:]}.mp4" for cam in CAMERAS}

# ---------------------------------------------------------------
# Models (Tier 2)
# ---------------------------------------------------------------
# best_v5_full_combined.pt is your newest/combined weight file per the
# tree you shared -- change to whichever checkpoint is actually best.
POSE_WEIGHTS = ROOT_DIR / "models" / "pose-detection" / "weights" / "best_v5_full_combined.pt"

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
FRAME_HEIGHT = 1080
FRAME_WIDTH = 1920
FRAME_CHANNELS = 3

# ---------------------------------------------------------------
# Tier 1 - always-on lightweight detector
# ---------------------------------------------------------------
TIER1_DOWNSCALE = 0.25         # process at 25% resolution for speed
TIER1_MIN_CONTOUR_AREA = 400   # in downscaled px^2 -- tune per camera framing
TIER1_HISTORY = 500
TIER1_VAR_THRESHOLD = 32

# ---------------------------------------------------------------
# Tier 2 - Ray cluster
# ---------------------------------------------------------------
RAY_NUM_CPUS = 4
POSE_CONF_THRESHOLD = 0.3

# Index into the model's keypoint array corresponding to each wheel.
# Ultralytics pose models return keypoints in the order they were
# labeled during training -- update these to match best_v5's actual
# label order (check your data.yaml / Roboflow export / readme.md).
WHEEL_KEYPOINT_INDICES = {
    "front_left": 0,
    "front_right": 1,
    "rear_left": 2,
    "rear_right": 3,
}

# ---------------------------------------------------------------
# Kafka (Step 4 - alert to Electron)
# ---------------------------------------------------------------
KAFKA_BOOTSTRAP_SERVERS = ["localhost:9092"]
KAFKA_TOPIC = "track-violations"
