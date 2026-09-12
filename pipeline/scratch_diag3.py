"""Deep diagnostic: examine what the pose model detects across CAM6 frames 0-50,
check confidence scores, and investigate the false-detection pattern."""

import numpy as np
import cv2
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

from ultralytics import YOLO

weights = ROOT / "models" / "pose-detection" / "weights" / "best_v4_full_color.pt"
model = YOLO(str(weights))
MASK_DIR = ROOT / "models" / "track-segmentation" / "track_boundaries" / "masks"

# Load CAM6 mask
npz = MASK_DIR / "CAM6_inside_packed.npz"
data = np.load(npz)
shape = tuple(data["shape"])
mask = np.unpackbits(data["packed_mask"])[: shape[0] * shape[1]].reshape(shape)

vid = ROOT / "simulation-footage" / "CAM-6.mp4"
cap = cv2.VideoCapture(str(vid))

print("Scanning CAM6 frames 0-100 for detections...")
print(f"{'Frame':>5} | {'Dets':>4} | {'Conf':>8} | {'Box (xyxy)':>40} | {'KP0 (x,y)':>16} | Inside?")
print("-" * 110)

for frame_idx in range(101):
    ok, frame = cap.read()
    if not ok:
        break
    
    results = model.predict(source=frame, conf=0.3, device="cpu", verbose=False)
    result = results[0]
    n_dets = len(result.boxes)
    
    if n_dets > 0:
        for det_i in range(n_dets):
            conf = float(result.boxes.conf[det_i])
            box = result.boxes.xyxy[det_i].cpu().numpy()
            box_str = f"({box[0]:.0f},{box[1]:.0f})-({box[2]:.0f},{box[3]:.0f})"
            
            if result.keypoints is not None and det_i < len(result.keypoints):
                kpts = result.keypoints.xy[det_i].cpu().numpy()
                # Check visibility/confidence of keypoints if available
                has_kpt_conf = hasattr(result.keypoints, 'conf') and result.keypoints.conf is not None
                if has_kpt_conf:
                    kpt_confs = result.keypoints.conf[det_i].cpu().numpy()
                else:
                    kpt_confs = None
                
                kp0 = kpts[0]
                
                # Check how many keypoints are near (0,0) -- i.e. invalid/not-visible
                zero_kpts = sum(1 for x, y in kpts if x < 5 and y < 5)
                
                # Check wheel points (indices 0-3) against mask
                wheel_indices = [0, 1, 2, 3]
                violations = []
                for wi in wheel_indices:
                    if wi < len(kpts):
                        x, y = kpts[wi]
                        ix, iy = int(round(x)), int(round(y))
                        if 0 <= iy < shape[0] and 0 <= ix < shape[1]:
                            is_in = bool(mask[iy, ix])
                        else:
                            is_in = False
                        if not is_in:
                            violations.append(wi)
                
                kp_conf_str = ""
                if kpt_confs is not None:
                    kp_conf_str = f" kp_confs=[{','.join(f'{c:.2f}' for c in kpt_confs[:4])}]"
                
                print(f"{frame_idx:5d} | {n_dets:4d} | {conf:8.4f} | {box_str:>40} | ({kp0[0]:7.1f},{kp0[1]:7.1f}) | "
                      f"zero_kpts={zero_kpts} viol_wheels={violations}{kp_conf_str}")
            else:
                print(f"{frame_idx:5d} | {n_dets:4d} | {conf:8.4f} | {box_str:>40} | NO KEYPOINTS")
    # else: frame_idx has no detections -- skip printing for cleanliness

cap.release()
print("\nDone.")
