"""Sample-rate and sample-format conversion. NumPy only, no native dependencies."""

from __future__ import annotations

import numpy as np


def resample(x: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    """Mono float32 resampling.

    Down-sampling averages blocks first (a crude low-pass filter that avoids the worst aliasing),
    then interpolates linearly. That is good enough for speech recognition and keeps the service
    free of heavy audio dependencies; music-grade quality is not a goal.
    """
    if src_rate == dst_rate or x.size == 0:
        return x.astype(np.float32, copy=False)
    if src_rate % dst_rate == 0:  # exact integer decimation, e.g. 48 kHz -> 16 kHz
        k = src_rate // dst_rate
        n = (x.size // k) * k
        return x[:n].reshape(-1, k).mean(axis=1).astype(np.float32)
    if src_rate > dst_rate:
        # Cheap low-pass: moving average whose width is the rate ratio, then interpolate.
        width = max(1, int(round(src_rate / dst_rate)))
        x = np.convolve(x, np.ones(width, dtype=np.float32) / width, mode="same")
    n_out = int(round(x.size * dst_rate / src_rate))
    positions = np.linspace(0, x.size - 1, n_out)
    return np.interp(positions, np.arange(x.size), x).astype(np.float32)


def pcm16_to_float(data: bytes | memoryview) -> np.ndarray:
    """Little-endian signed 16-bit PCM to float32 in [-1, 1]. Odd trailing byte is dropped."""
    n = (len(data) // 2) * 2
    return np.frombuffer(bytes(data[:n]), dtype="<i2").astype(np.float32) / 32768.0


def float_to_pcm16(x: np.ndarray) -> bytes:
    """Float32 in [-1, 1] to little-endian PCM16, clipped (never wraps around)."""
    return (np.clip(x, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
