"""
Tier 2 -> Electron bridge.

Confirmed violations are packaged as a small JSON payload (camera,
frame range, no video). Two ways to deliver that payload:

  - LocalAlertLogger    -- default for now. No broker needed; just
                           prints and appends to a local JSON-lines
                           file so you can see what *would* have been
                           sent, while Electron isn't listening yet.
  - ViolationAlertProducer -- pushes to Kafka. Switch to this once the
                           Electron dashboard is built and subscribing
                           to the `track-violations` topic.

Both expose the same `.send(result)` interface, so orchestrator.py
doesn't care which one it's holding.
"""

import json
import time
from pathlib import Path

from . import config


class LocalAlertLogger:
    """Drop-in stand-in for ViolationAlertProducer that needs no broker.
    Use this until the Electron app is ready to consume Kafka."""

    def __init__(self, log_path: Path = config.ROOT_DIR / "pipeline" / "violations.jsonl"):
        self.log_path = log_path

    def send(self, result: dict) -> None:
        payload = {
            "camera": result["camera"],
            "clip_start_frame": result["clip_start_frame"],
            "clip_end_frame": result["clip_end_frame"],
            "violating_frames": result["violating_frames"],
            "avg_probability": result.get("avg_probability", 0.0),
            "frame_probabilities": result.get("frame_probabilities", []),
            "timestamp": time.time(),
        }
        with open(self.log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(payload) + "\n")

        print(
            f"[LOCAL] Violation logged for {result['camera']}: "
            f"frames {payload['clip_start_frame']}-{payload['clip_end_frame']} "
            f"avg_prob={payload['avg_probability']:.1%} "
            f"(-> {self.log_path})"
        )


class ViolationAlertProducer:
    """Pushes the same payload to Kafka instead. Requires a broker
    running (see config.KAFKA_BOOTSTRAP_SERVERS) and kafka-python
    installed."""

    def __init__(self, bootstrap_servers=None, topic: str = config.KAFKA_TOPIC):
        from kafka import KafkaProducer  # kafka-python

        self.topic = topic
        self.producer = KafkaProducer(
            bootstrap_servers=bootstrap_servers or config.KAFKA_BOOTSTRAP_SERVERS,
            value_serializer=lambda v: json.dumps(v).encode("utf-8"),
        )

    def send(self, result: dict) -> None:
        payload = {
            "camera": result["camera"],
            "clip_start_frame": result["clip_start_frame"],
            "clip_end_frame": result["clip_end_frame"],
            "violating_frames": result["violating_frames"],
            "avg_probability": result.get("avg_probability", 0.0),
            "frame_probabilities": result.get("frame_probabilities", []),
            "timestamp": time.time(),
        }
        self.producer.send(self.topic, payload)
        self.producer.flush()
        print(
            f"[Kafka] Sent violation alert for {result['camera']}: "
            f"frames {payload['clip_start_frame']}-{payload['clip_end_frame']} "
            f"avg_prob={payload['avg_probability']:.1%}"
        )