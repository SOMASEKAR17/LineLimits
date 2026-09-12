"""
Entry point. Opens all 8 videos, runs the master synced-clock loop
(Step 1 of the blueprint), applies Tier 1 filtering to each frame, and
on trigger locks a clip and hands it to Tier 2 (Ray) then Tier 3 (an
alert -- local file by default, Kafka once Electron is ready).

Confirmed violations are also clipped from the source video and saved
as MP4 files in the `flagged/` directory at the project root.

Run with:
    python -m pipeline.orchestrator                # local logger, no Kafka needed
    python -m pipeline.orchestrator --use-kafka     # once a broker + Electron are up
"""

import argparse
from enum import Enum, auto

import cv2
import ray

from . import config
from .alert_producer import LocalAlertLogger, ViolationAlertProducer
from .shared_ring_buffer import CameraRingBuffer
from .tier1_lightweight_detector import Tier1Detector
from .tier2_processor import process_locked_clip


class CamState(Enum):
    IDLE = auto()        # no car seen, just filling the ring buffer
    ARMED = auto()        # car seen, counting down POST_TRIGGER_FRAMES


class CameraContext:
    def __init__(self, camera: str):
        self.camera = camera
        self.cap = cv2.VideoCapture(str(config.VIDEO_PATHS[camera]))
        if not self.cap.isOpened():
            raise RuntimeError(f"Could not open video for {camera}: {config.VIDEO_PATHS[camera]}")

        self.fps = self.cap.get(cv2.CAP_PROP_FPS) or 30.0
        self.ring_buffer = CameraRingBuffer(camera)
        self.detector = Tier1Detector()
        self.state = CamState.IDLE
        self.post_trigger_remaining = 0


def _save_flagged_clip(camera: str, result: dict, fps: float) -> str:
    """Extract the flagged frame range from the original video and save
    it as an MP4 file in the `flagged/` directory.

    Returns the path of the saved clip.
    """
    config.FLAGGED_DIR.mkdir(parents=True, exist_ok=True)

    start_frame = result["clip_start_frame"]
    end_frame = result["clip_end_frame"]
    avg_prob = result["avg_probability"]

    filename = (
        f"{camera}_f{start_frame}-{end_frame}_prob{avg_prob:.0%}.mp4"
    )
    out_path = config.FLAGGED_DIR / filename

    src_video = config.VIDEO_PATHS[camera]
    cap = cv2.VideoCapture(str(src_video))
    if not cap.isOpened():
        print(f"  WARNING: could not re-open {src_video} for clip extraction.")
        return ""

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(str(out_path), fourcc, fps, (width, height))

    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)

    for _ in range(end_frame - start_frame + 1):
        ok, frame = cap.read()
        if not ok:
            break
        writer.write(frame)

    writer.release()
    cap.release()

    print(f"  [CLIP] Saved flagged clip -> {out_path}")
    return str(out_path)


def run(use_kafka: bool = False):
    ray.init(num_cpus=config.RAY_NUM_CPUS, ignore_reinit_error=True)

    # Pose model is loaded lazily as a singleton in the main process
    # (PoseModel.get()) so it can use the GPU directly.  Ray is only
    # used for the lightweight boundary-checking tasks.

    alert_producer = ViolationAlertProducer() if use_kafka else LocalAlertLogger()
    print(f"Alert sink: {'Kafka' if use_kafka else 'local file (pipeline/violations.jsonl)'}")
    print(f"Violation probability threshold: {config.VIOLATION_PROBABILITY_THRESHOLD:.0%}")
    print(f"Flagged clips will be saved to: {config.FLAGGED_DIR}")

    cams = {cam: CameraContext(cam) for cam in config.CAMERAS}

    frame_index = 0
    try:
        while True:
            any_frame_read = False

            for i, (camera, ctx) in enumerate(cams.items()):
                success, frame = ctx.cap.read()
                if not success:
                    continue
                any_frame_read = True

                ctx.ring_buffer.push(frame, frame_index)
                car_present = ctx.detector.detect(frame)

                if ctx.state == CamState.IDLE and car_present:
                    ctx.state = CamState.ARMED
                    ctx.post_trigger_remaining = config.POST_TRIGGER_FRAMES

                elif ctx.state == CamState.ARMED:
                    ctx.post_trigger_remaining -= 1
                    if car_present:
                        # Car still in frame -- keep extending the window
                        # so we don't cut off mid-passage.
                        ctx.post_trigger_remaining = config.POST_TRIGGER_FRAMES

                    if ctx.post_trigger_remaining <= 0:
                        _lock_and_dispatch(ctx, alert_producer)
                        ctx.state = CamState.IDLE

            if not any_frame_read:
                break
            frame_index += 1

    finally:
        for ctx in cams.values():
            ctx.cap.release()
            ctx.ring_buffer.close()
        ray.shutdown()


def _lock_and_dispatch(ctx: CameraContext, alert_producer) -> None:
    window = config.PRE_TRIGGER_FRAMES + config.POST_TRIGGER_FRAMES
    frames, frame_indices = ctx.ring_buffer.snapshot_window(window)

    print(
        f"[{ctx.camera}] Locking clip: frames "
        f"{frame_indices[0]}-{frame_indices[-1]} -> Tier 2 (GPU)"
    )

    result = process_locked_clip(ctx.camera, frames, frame_indices)

    if result["violation"]:
        alert_producer.send(result)
        _save_flagged_clip(ctx.camera, result, ctx.fps)
    else:
        print(f"[{ctx.camera}] Clip cleared, no violation confirmed.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--use-kafka",
        action="store_true",
        help="Publish violation alerts to Kafka instead of the local JSONL log. "
        "Requires a broker running at config.KAFKA_BOOTSTRAP_SERVERS.",
    )
    args = parser.parse_args()
    run(use_kafka=args.use_kafka)