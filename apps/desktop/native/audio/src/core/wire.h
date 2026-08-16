#pragma once

// The §5.2 wire format (docs/superpowers/specs/2026-08-11-desktop-pivot-design.md):
// 16 kHz · 16-bit signed · mono · little-endian · 20 ms frames, delivered in
// ~60 ms batches to keep per-call FFI overhead down. Every STT vendor accepts
// this and modules/stt already expects it. The capture sessions normalise the
// OS's native rates and channel counts INTO this format, so nothing downstream
// of them ever meets a device's own numbers.
namespace nova::audio::wire {

inline constexpr int kSampleRateHz = 16000;
inline constexpr int kFrameSamples = 320;  // 20 ms at 16 kHz
inline constexpr int kFramesPerBatch = 3;  // ~60 ms per delivery
inline constexpr int kBatchSamples = kFrameSamples * kFramesPerBatch;

}  // namespace nova::audio::wire
