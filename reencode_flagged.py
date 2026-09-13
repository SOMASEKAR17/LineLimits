"""Re-encode flagged clips from FMP4 (MPEG-4 Part 2) to H.264 for Chromium compatibility."""
import cv2
import os
import sys

FLAGGED_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "flagged")

if not os.path.isdir(FLAGGED_DIR):
    print(f"No flagged directory found at {FLAGGED_DIR}")
    sys.exit(0)

files = [f for f in os.listdir(FLAGGED_DIR) if f.endswith(".mp4")]
if not files:
    print("No MP4 files found in flagged/")
    sys.exit(0)

for filename in files:
    src_path = os.path.join(FLAGGED_DIR, filename)
    tmp_path = src_path + ".tmp.mp4"
    
    cap = cv2.VideoCapture(src_path)
    if not cap.isOpened():
        print(f"  SKIP (cannot open): {filename}")
        continue
    
    # Check current codec
    fourcc_int = int(cap.get(cv2.CAP_PROP_FOURCC))
    codec = chr(fourcc_int & 0xFF) + chr((fourcc_int >> 8) & 0xFF) + chr((fourcc_int >> 16) & 0xFF) + chr((fourcc_int >> 24) & 0xFF)
    
    if codec.lower() in ("avc1", "h264"):
        print(f"  SKIP (already H.264): {filename}")
        cap.release()
        continue
    
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    print(f"  Re-encoding {filename} ({codec} -> H.264, {total} frames @ {w}x{h})...")
    
    # Try H.264 codec
    out_fourcc = cv2.VideoWriter_fourcc(*"avc1")
    writer = cv2.VideoWriter(tmp_path, out_fourcc, fps, (w, h))
    
    if not writer.isOpened():
        # Fallback: try X264
        out_fourcc = cv2.VideoWriter_fourcc(*"X264")
        writer = cv2.VideoWriter(tmp_path, out_fourcc, fps, (w, h))
    
    if not writer.isOpened():
        print(f"    ERROR: H.264 encoder not available, skipping {filename}")
        cap.release()
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        continue
    
    count = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        writer.write(frame)
        count += 1
    
    cap.release()
    writer.release()
    
    # Verify the output
    test_cap = cv2.VideoCapture(tmp_path)
    test_ok = test_cap.isOpened() and test_cap.get(cv2.CAP_PROP_FRAME_COUNT) > 0
    test_cap.release()
    
    if test_ok:
        os.replace(tmp_path, src_path)
        print(f"    Done: {count} frames written")
    else:
        print(f"    ERROR: output verification failed for {filename}")
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

print("\nRe-encoding complete.")
