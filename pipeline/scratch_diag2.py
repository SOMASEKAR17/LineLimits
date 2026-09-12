"""Verify: does position (0,0) fall inside or outside the track masks?
Also: what does the pose model return on an empty frame (no car)?"""

import numpy as np
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MASK_DIR = ROOT / "models" / "track-segmentation" / "track_boundaries" / "masks"

print("=" * 60)
print("Is (0,0) inside the track mask for each camera?")
print("=" * 60)
for cam_id in range(1, 9):
    cam = f"CAM{cam_id}"
    npz = MASK_DIR / f"{cam}_inside_packed.npz"
    data = np.load(npz)
    shape = tuple(data["shape"])
    mask = np.unpackbits(data["packed_mask"])[: shape[0] * shape[1]].reshape(shape)
    val_00 = bool(mask[0, 0])
    # Also check a few edge/corner positions
    val_center = bool(mask[shape[0]//2, shape[1]//2])
    print(f"  {cam}: (0,0)={val_00}, center({shape[1]//2},{shape[0]//2})={val_center}")

print()
print("=" * 60)
print("Testing pose model on an empty frame (pure black)")
print("=" * 60)
import cv2
try:
    from ultralytics import YOLO
    weights = ROOT / "models" / "pose-detection" / "weights" / "best_v4_full_color.pt"
    model = YOLO(str(weights))
    
    # Create a blank frame (no car)
    blank = np.zeros((720, 1280, 3), dtype=np.uint8)
    results = model.predict(source=blank, conf=0.3, device="cpu", verbose=False)
    result = results[0]
    
    print(f"  Detections on blank frame: {len(result.boxes)}")
    if result.keypoints is not None and len(result.keypoints) > 0:
        kpts = result.keypoints.xy[0].cpu().numpy()
        print(f"  Keypoints returned: {kpts}")
    else:
        print("  No keypoints returned (correct behavior)")
    
    # Now test on an actual frame with a car
    vid = ROOT / "simulation-footage" / "CAM-6.mp4"
    cap = cv2.VideoCapture(str(vid))
    cap.set(cv2.CAP_PROP_POS_FRAMES, 50)
    ok, frame = cap.read()
    cap.release()
    
    if ok:
        results2 = model.predict(source=frame, conf=0.3, device="cpu", verbose=False)
        result2 = results2[0]
        print(f"\n  Detections on CAM6 frame 50: {len(result2.boxes)}")
        if result2.keypoints is not None and len(result2.keypoints) > 0:
            kpts2 = result2.keypoints.xy[0].cpu().numpy()
            print(f"  Keypoints: {kpts2}")
            # Check each keypoint against the mask
            npz = MASK_DIR / f"CAM6_inside_packed.npz"
            data = np.load(npz)
            shape = tuple(data["shape"])
            mask = np.unpackbits(data["packed_mask"])[: shape[0] * shape[1]].reshape(shape)
            for i, (x, y) in enumerate(kpts2):
                ix, iy = int(round(x)), int(round(y))
                inside = bool(mask[iy, ix]) if (0 <= iy < shape[0] and 0 <= ix < shape[1]) else False
                print(f"    kpt {i}: ({x:.1f}, {y:.1f}) -> inside={inside}")
        else:
            print("  No keypoints on CAM6 frame 50")
            
except Exception as e:
    print(f"  Error: {e}")
