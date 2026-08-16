#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

#include "framer.h"
#include "gap_filler.h"
#include "sample_queue.h"
#include "stream.h"
#include "stream_mixer.h"

namespace nova::audio {

// One labelled stream end to end: capture threads push raw wire-format
// samples into queue(i); the engine thread calls tick(); labelled wire
// batches fall out. Composition per source is queue → gap filler → mixer,
// then one framer on the mixed result:
//
//   queue(0) ─ drain ─ gap-fill ─┐
//   queue(1) ─ drain ─ gap-fill ─┴─ mix ─ frame ─→ FrameBatch{label, …}
//
// The source count is FIXED at construction, by design. "Them" is always two
// sources (the multimedia and communications default outputs, §6 chunk 2)
// even when both roles point at one device: the empty slot just runs dead —
// setSourceLive(false) — contributing gap-filled silence that mixes as a
// no-op. The engine therefore never reshapes a pipeline mid-call, and a gap
// filler is never recreated (a fresh one would read the whole call so far as
// one giant gap).
class StreamPipeline {
 public:
  StreamPipeline(StreamLabel label, int sourceCount);

  // Thread-safe to push into from capture threads; everything else on this
  // class belongs to the engine thread alone.
  SampleQueue& queue(int source);

  // A dead source (no device behind it) keeps pace with pure silence, so the
  // mixer never stalls waiting on it and it mixes as a no-op.
  void setSourceLive(int source, bool live);

  // Engine tick: `wallSamples` is how many samples the wall clock says should
  // exist since capture started. Appends completed batches to `out`.
  void tick(size_t wallSamples, std::vector<FrameBatch>& out);

  struct Stats {
    size_t droppedSamples;
    size_t injectedSilenceSamples;
  };
  Stats stats() const;

 private:
  struct Source {
    SampleQueue queue;
    GapFiller filler;
    std::vector<int16_t> scratch;
  };

  StreamLabel label_;
  // unique_ptr because SampleQueue owns a mutex and cannot move.
  std::vector<std::unique_ptr<Source>> sources_;
  StreamMixer mixer_;
  Framer framer_;
  std::vector<int16_t> silence_;
  std::vector<int16_t> mixed_;
  std::vector<std::vector<int16_t>> batches_;
};

}  // namespace nova::audio
