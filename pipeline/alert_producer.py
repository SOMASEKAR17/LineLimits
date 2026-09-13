"""
Tier 2 -> Electron bridge.

Confirmed violations are packaged as a small JSON payload (camera,
frame range, no video). Two ways to deliver that payload:

Either way the payload carries the car's identity: Tier 2 knows a car
left the track on camera N over frames A-B, and car_identifier.py
correlates that window against the transponder loop co-located with
that camera to say which car it was.

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
from .car_identifier import CarIdentifier


# Shared across both producers — loads the entry list and the transponder
# loop feed once, then correlates each violation window against it.
_identifier: CarIdentifier | None = None


def _identify(result: dict) -> dict | None:
    """Resolve which car the violation belongs to.

    Tier 2 confirms *that* a car left the track on a given camera over a
    given frame window; it has no idea which car that was. The transponder
    loop co-located with that camera does, so the window is correlated
    against the loop feed for an identity.
    """
    global _identifier
    if _identifier is None:
        _identifier = CarIdentifier()
    try:
        return _identifier.identify(
            result["camera"],
            result["clip_start_frame"],
            result["clip_end_frame"],
        )
    except Exception as err:  # identification must never sink an alert
        print(f"[car_identifier] identification failed: {err}")
        return None


def _build_payload(result: dict) -> dict:
    car = _identify(result)
    return {
        "camera": result["camera"],
        "clip_start_frame": result["clip_start_frame"],
        "clip_end_frame": result["clip_end_frame"],
        "violating_frames": result["violating_frames"],
        "avg_probability": result.get("avg_probability", 0.0),
        "frame_probabilities": result.get("frame_probabilities", []),
        "verified": result.get("verified", False),
        "ground_truth_label": result.get("ground_truth_label", ""),
        "car": car,
        "timestamp": time.time(),
    }


def _car_summary(payload: dict) -> str:
    car = payload.get("car")
    if not car:
        return "car unidentified"
    return (
        f"#{car['number']} {car['driver']} ({car['teamShort']}) "
        f"id={car['confidence']:.0%} via {car['loopId']}"
    )


class LocalAlertLogger:
    """Drop-in stand-in for ViolationAlertProducer that needs no broker.
    Use this until the Electron app is ready to consume Kafka."""

    def __init__(self, log_path: Path = config.ROOT_DIR / "pipeline" / "violations.jsonl"):
        self.log_path = log_path

    def send(self, result: dict) -> None:
        payload = _build_payload(result)
        with open(self.log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(payload) + "\n")

        print(
            f"[LOCAL] Violation logged for {result['camera']}: "
            f"frames {payload['clip_start_frame']}-{payload['clip_end_frame']} "
            f"avg_prob={payload['avg_probability']:.1%} "
            f"| {_car_summary(payload)} "
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
        payload = _build_payload(result)
        self.producer.send(self.topic, payload)
        self.producer.flush()
        print(
            f"[Kafka] Sent violation alert for {result['camera']}: "
            f"frames {payload['clip_start_frame']}-{payload['clip_end_frame']} "
            f"avg_prob={payload['avg_probability']:.1%} "
            f"| {_car_summary(payload)}"
        )