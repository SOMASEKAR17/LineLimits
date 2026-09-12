import argparse
from pathlib import Path

import cv2
from ultralytics import YOLO

# to run the script, use the following command in the terminal:
# python .\video_pose.py --source-dir .\data\real-life-footage --model backups\best_v4_full_color.pt
# (or just: python .\video_pose.py  — since both --source-dir and --model now have defaults)

VIDEO_EXTENSIONS = (".mp4", ".avi", ".mov", ".mkv")


def process_video(model, video_path: Path, output_path: Path, conf: float, device):
    """
    Run pose detection on a single video and write the annotated
    result to output_path, preserving the source video's fps and
    resolution.
    """

    cap = cv2.VideoCapture(str(video_path))

    if not cap.isOpened():
        print(f"  WARNING: could not open {video_path}, skipping.")
        return 0

    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()

    output_path.parent.mkdir(parents=True, exist_ok=True)

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(str(output_path), fourcc, fps, (width, height))

    if not writer.isOpened():
        print(f"  WARNING: could not create writer for {output_path}, skipping.")
        return 0

    results = model.predict(
        source=str(video_path),
        conf=conf,
        device=device,
        save=False,     # we handle writing ourselves so the filename matches exactly
        stream=True,    # process frame-by-frame instead of loading whole video into memory
        verbose=False,
    )

    frame_count = 0
    for result in results:
        annotated_frame = result.plot()  # BGR numpy array with keypoints/boxes drawn
        writer.write(annotated_frame)

        frame_count += 1
        if frame_count % 30 == 0:
            print(f"  Processed {frame_count} frames...")

    writer.release()
    return frame_count


def main():
    parser = argparse.ArgumentParser(
        description="Run pose detection on every video in a folder and save annotated outputs"
    )
    parser.add_argument(
        "--source-dir",
        default="data/real-life-footage",
        help="Folder containing input videos (default: data/real-life-footage)",
    )
    parser.add_argument(
        "--model",
        default="backups/best_v4_full_color.pt",
        help="Path to trained model weights (default: v4, the current best model — 200-image dataset, color-only)",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Folder to save annotated videos into "
        "(default: <source-dir>/processed_footages)",
    )
    parser.add_argument("--conf", type=float, default=0.3, help="Confidence threshold")
    parser.add_argument("--device", default=0, help="Device: 0 for GPU, 'cpu' for CPU")
    args = parser.parse_args()

    source_dir = Path(args.source_dir)
    if not source_dir.exists() or not source_dir.is_dir():
        raise FileNotFoundError(f"Source folder not found: {source_dir}")

    model_path = Path(args.model)
    if not model_path.exists():
        raise FileNotFoundError(f"Model weights not found: {model_path}")

    output_dir = Path(args.output_dir) if args.output_dir else source_dir / "processed_footages"
    output_dir.mkdir(parents=True, exist_ok=True)

    video_paths = sorted(
        p for p in source_dir.iterdir()
        if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS
    )

    if not video_paths:
        print(f"No videos found in {source_dir}")
        return

    print(f"Found {len(video_paths)} video(s) in {source_dir}")
    print(f"Loading model {model_path} ...")
    model = YOLO(str(model_path))

    for i, video_path in enumerate(video_paths, start=1):
        output_path = output_dir / video_path.name  # same filename as the source

        print(f"\n[{i}/{len(video_paths)}] Processing {video_path.name} ...")
        frame_count = process_video(model, video_path, output_path, args.conf, args.device)
        print(f"  Done. {frame_count} frames processed.")
        print(f"  Saved to: {output_path}")

    print(f"\nAll videos processed. Output folder: {output_dir}")


if __name__ == "__main__":
    main()