"""Quick diagnostic: check mask shapes vs video frame shapes and
inspect what the boundary checker actually decides on a few sample frames."""

import numpy as np
import cv2
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MASK_DIR = ROOT / "models" / "track-segmentation" / "track_boundaries" / "masks"
VIDEO_DIR = ROOT / "simulation-footage"

print("=" * 60)
print("MASK DIMENSIONS")
print("=" * 60)
for cam_id in range(1, 9):
    cam = f"CAM{cam_id}"
    npz = MASK_DIR / f"{cam}_inside_packed.npz"
    if npz.exists():
        data = np.load(npz)
        shape = tuple(data["shape"])
        mask = np.unpackbits(data["packed_mask"])[: shape[0] * shape[1]].reshape(shape)
        ones = np.count_nonzero(mask)
        total = mask.size
        print(f"  {cam}: mask shape = {shape}, "
              f"inside_pixels = {ones}/{total} ({100*ones/total:.1f}%)")
    else:
        print(f"  {cam}: MISSING packed npz")

print()
print("=" * 60)
print("VIDEO DIMENSIONS")
print("=" * 60)
for cam_id in range(1, 9):
    cam = f"CAM{cam_id}"
    vid = VIDEO_DIR / f"CAM-{cam_id}.mp4"
    if vid.exists():
        cap = cv2.VideoCapture(str(vid))
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = cap.get(cv2.CAP_PROP_FPS)
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        cap.release()
        print(f"  {cam}: video = {w}x{h} @ {fps:.1f} fps, {total} frames")
    else:
        print(f"  {cam}: MISSING video")

print()
print("=" * 60)
print("MISMATCH CHECK")
print("=" * 60)
for cam_id in range(1, 9):
    cam = f"CAM{cam_id}"
    npz = MASK_DIR / f"{cam}_inside_packed.npz"
    vid = VIDEO_DIR / f"CAM-{cam_id}.mp4"
    if npz.exists() and vid.exists():
        data = np.load(npz)
        mask_h, mask_w = tuple(data["shape"])
        cap = cv2.VideoCapture(str(vid))
        vid_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        vid_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        cap.release()
        match = "OK" if (mask_h == vid_h and mask_w == vid_w) else "MISMATCH!"
        print(f"  {cam}: mask ({mask_w}x{mask_h}) vs video ({vid_w}x{vid_h}) -> {match}")
