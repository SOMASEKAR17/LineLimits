import cv2
import numpy as np

from . import config


class Tier1Detector:
    def __init__(
        self,
        downscale: float = config.TIER1_DOWNSCALE,
        min_area: float = config.TIER1_MIN_CONTOUR_AREA,
        warmup_frames: int = config.TIER1_WARMUP_FRAMES,
    ):
        self.downscale = downscale
        self.min_area = min_area
        self.warmup_frames = warmup_frames
        self._frames_seen = 0
        self.bg_subtractor = cv2.createBackgroundSubtractorMOG2(
            history=config.TIER1_HISTORY,
            varThreshold=config.TIER1_VAR_THRESHOLD,
            detectShadows=False,
        )

    def detect(self, frame: np.ndarray) -> bool:
        """True if a moving foreground blob big enough to be a car is
        present in this frame."""
        small = cv2.resize(frame, None, fx=self.downscale, fy=self.downscale)
        fg_mask = self.bg_subtractor.apply(small)

        self._frames_seen += 1
        if self._frames_seen <= self.warmup_frames:
            # MOG2 has no background model yet -- everything looks like
            # foreground for the first few dozen frames. Keep feeding it
            # frames (the .apply() call above still trains it) but don't
            # report triggers until it has stabilized.
            return False

        # Clean up sensor noise before measuring blob size.
        fg_mask = cv2.morphologyEx(fg_mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))

        contours, _ = cv2.findContours(fg_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        return any(cv2.contourArea(c) >= self.min_area for c in contours)


class Tier1YoloDetector:
    def __init__(self, weights_path, conf: float = 0.25, device=0):
        from ultralytics import YOLO

        self.model = YOLO(str(weights_path))
        self.conf = conf
        self.device = device

    def detect(self, frame: np.ndarray) -> bool:
        results = self.model.predict(frame, conf=self.conf, device=self.device, verbose=False)
        return len(results[0].boxes) > 0