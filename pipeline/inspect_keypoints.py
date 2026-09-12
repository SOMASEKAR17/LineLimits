"""
One-off diagnostic: runs the pose model on a single frame and draws
each keypoint's index number next to it, so you can visually match
index -> physical wheel (front-left, front-right, rear-left, rear-right).

Run with:
    python -m pipeline.inspect_keypoints --camera CAM1 --frame 50

Look at the saved image, note which index lands on which wheel, then
update WHEEL_KEYPOINT_INDICES in config.py to match.
"""

import argparse

import cv2

from . import config


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--camera", default="CAM1", help="e.g. CAM1")
    parser.add_argument("--frame", type=int, default=50, help="frame number to sample")
    parser.add_argument(
        "--out", default="keypoint_check.jpg", help="output image filename"
    )
    args = parser.parse_args()

    video_path = config.VIDEO_PATHS[args.camera]
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open {video_path}")

    cap.set(cv2.CAP_PROP_POS_FRAMES, args.frame)
    success, frame = cap.read()
    cap.release()

    if not success:
        raise RuntimeError(f"Could not read frame {args.frame} from {video_path}")

    from ultralytics import YOLO

    model = YOLO(str(config.POSE_WEIGHTS))
    results = model.predict(source=frame, conf=config.POSE_CONF_THRESHOLD, verbose=False)

    result = results[0]
    if result.keypoints is None or len(result.keypoints) == 0:
        print("No detections/keypoints found in this frame. Try a different --frame.")
        return

    kpts = result.keypoints.xy[0].cpu().numpy()
    annotated = result.plot()  # boxes + keypoints already drawn by ultralytics

    for idx, (x, y) in enumerate(kpts):
        cv2.putText(
            annotated,
            str(idx),
            (int(x) + 8, int(y) - 8),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.9,
            (0, 0, 255),
            2,
            cv2.LINE_AA,
        )
        print(f"Keypoint {idx}: x={x:.1f}, y={y:.1f}")

    cv2.imwrite(args.out, annotated)
    print(f"\nSaved annotated frame to: {args.out}")
    print("Open it and match each red index number to the physical wheel it sits on.")


if __name__ == "__main__":
    main()