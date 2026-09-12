"""
Per-camera circular frame buffer backed by multiprocessing.shared_memory.

Frames are pushed in as they're decoded by ingestion/orchestrator. Tier 1
flags a camera when a car appears; the buffer keeps recording for
POST_TRIGGER_FRAMES more frames, then a snapshot of the whole window
(PRE + POST) is copied out so Tier 2 can process it without racing
against new writes overwriting the ring.
"""

from __future__ import annotations

from multiprocessing import shared_memory

import cv2
import numpy as np

from . import config


class CameraRingBuffer:
    def __init__(
        self,
        camera: str,
        height: int = config.FRAME_HEIGHT,
        width: int = config.FRAME_WIDTH,
        channels: int = config.FRAME_CHANNELS,
        depth: int = config.RING_BUFFER_FRAMES,
    ):
        self.camera = camera
        self.depth = depth
        self.shape = (depth, height, width, channels)
        nbytes = int(np.prod(self.shape))

        self._shm = shared_memory.SharedMemory(create=True, size=nbytes)
        self.frames = np.ndarray(self.shape, dtype=np.uint8, buffer=self._shm.buf)

        # Absolute (video-wide) frame index stored in each ring slot.
        self.frame_indices = np.full(depth, -1, dtype=np.int64)

        self._write_ptr = 0
        self._filled = 0

    def push(self, frame: np.ndarray, absolute_frame_index: int) -> None:
        """Write one decoded frame into the next ring slot."""
        if frame.shape[:2] != self.shape[1:3]:
            frame = cv2.resize(frame, (self.shape[2], self.shape[1]))

        self.frames[self._write_ptr] = frame
        self.frame_indices[self._write_ptr] = absolute_frame_index

        self._write_ptr = (self._write_ptr + 1) % self.depth
        self._filled = min(self._filled + 1, self.depth)

    def snapshot_window(self, num_frames: int) -> tuple[np.ndarray, np.ndarray]:
        """
        Return a COPY of the most recent `num_frames` (oldest -> newest)
        plus their absolute frame indices.

        Copying out of shared memory here is what "locks" the slice --
        Tier 2 can keep working on it while ingestion keeps writing new
        frames into the live ring buffer underneath.
        """
        num_frames = min(num_frames, self._filled)
        idx = [(self._write_ptr - num_frames + i) % self.depth for i in range(num_frames)]
        return self.frames[idx].copy(), self.frame_indices[idx].copy()

    def close(self) -> None:
        self._shm.close()
        self._shm.unlink()