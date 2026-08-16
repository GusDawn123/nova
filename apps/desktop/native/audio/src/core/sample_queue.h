#pragma once

#include <cstddef>
#include <cstdint>
#include <mutex>
#include <vector>

#include "wire.h"

namespace nova::audio {

// The hand-off between a capture thread and the engine thread — the only
// place in core where two threads meet. A mutex around a memcpy rather than a
// lock-free ring: shared-mode WASAPI wakes every ~10 ms, so the lock is held
// for nanoseconds out of every 10 ms and contention is not a real cost here
// (core_bench exists to prove that claim to the profiler).
//
// Bounded: once `maxSamples` are queued, push() drops the INCOMING samples.
// Dropping new rather than old keeps what is queued contiguous, and the
// stream's timeline stays honest because the gap filler backfills the hole
// with silence once the consumer recovers.
class SampleQueue {
 public:
  // 10 seconds of wire audio (~320 KB) — far beyond any stall worth riding out.
  static constexpr size_t kDefaultMaxSamples =
      static_cast<size_t>(10) * wire::kSampleRateHz;

  explicit SampleQueue(size_t maxSamples = kDefaultMaxSamples);

  // Returns how many samples were dropped (0 in healthy operation).
  size_t push(const int16_t* samples, size_t count);

  // Appends everything queued to `out`; returns how many samples that was.
  size_t drainInto(std::vector<int16_t>& out);

  size_t droppedTotal() const;

 private:
  mutable std::mutex mutex_;
  std::vector<int16_t> buffer_;
  size_t dropped_ = 0;
  size_t maxSamples_;
};

}  // namespace nova::audio
