from typing import Dict, List, Tuple

import numpy as np

from . import config


class TrackBoundaryChecker:
    def __init__(self, mask_dir=config.MASK_DIR):
        self.mask_dir = mask_dir
        self._masks: Dict[str, np.ndarray] = {}

    def _load(self, camera: str) -> np.ndarray:
        if camera in self._masks:
            return self._masks[camera]

        packed_path = self.mask_dir / f"{camera}_inside_packed.npz"
        if not packed_path.exists():
            raise FileNotFoundError(
                f"No boundary mask for {camera} at {packed_path}. "
                f"Run models/track-segmentation/newewe.py first."
            )

        data = np.load(packed_path)
        shape = tuple(data["shape"])
        mask = np.unpackbits(data["packed_mask"])[: shape[0] * shape[1]].reshape(shape)
        self._masks[camera] = mask
        return mask

    def is_inside(self, camera: str, x: int, y: int) -> bool:
        mask = self._load(camera)
        h, w = mask.shape
        if not (0 <= y < h and 0 <= x < w):
            return False
        return bool(mask[y, x])

    # ------------------------------------------------------------------
    # Probability-based violation scoring
    # ------------------------------------------------------------------

    def _wheel_outside_ratio(
        self, camera: str, wheel_points: List[Tuple[float, float]]
    ) -> float:
        """Fraction of wheel keypoints that fall outside the track mask.
        Returns 0.0 (all inside) to 1.0 (all outside)."""
        if not wheel_points:
            return 0.0
        n_outside = sum(
            1
            for x, y in wheel_points
            if not self.is_inside(camera, int(round(x)), int(round(y)))
        )
        return n_outside / len(wheel_points)

    def _box_outside_ratio(
        self, camera: str, box_xyxy: Tuple[float, float, float, float]
    ) -> float:
        """Fraction of bounding-box pixels that fall outside the track mask.
        Returns 0.0 (fully inside) to 1.0 (fully outside)."""
        mask = self._load(camera)
        h, w = mask.shape

        x1 = max(0, int(round(box_xyxy[0])))
        y1 = max(0, int(round(box_xyxy[1])))
        x2 = min(w, int(round(box_xyxy[2])))
        y2 = min(h, int(round(box_xyxy[3])))

        if x2 <= x1 or y2 <= y1:
            return 1.0  # degenerate box, treat as fully outside

        box_region = mask[y1:y2, x1:x2]
        total_pixels = box_region.size
        inside_pixels = int(np.count_nonzero(box_region))
        outside_pixels = total_pixels - inside_pixels

        return outside_pixels / total_pixels

    def violation_probability(
        self,
        camera: str,
        wheel_points: List[Tuple[float, float]],
        box_xyxy: Tuple[float, float, float, float],
    ) -> float:
        """Combined probability that the car is off-track.

        Uses a weighted average:
          probability = WHEEL_WEIGHT * wheel_outside_ratio
                      + BOX_WEIGHT   * box_outside_ratio

        Wheels are the core signal; the bounding-box overlap is supporting
        evidence.  Returns 0.0 .. 1.0.
        """
        wheel_ratio = self._wheel_outside_ratio(camera, wheel_points)
        box_ratio = self._box_outside_ratio(camera, box_xyxy)

        probability = (
            config.WHEEL_WEIGHT * wheel_ratio
            + config.BOX_WEIGHT * box_ratio
        )
        return round(min(probability, 1.0), 4)