#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace nova::audio {

// Windows keeps two "default speaker" roles (multimedia and communications),
// and they can be two PHYSICAL devices — Zoom on the headset, media on the
// monitor speakers. "Them" is then the sum of both loopbacks. The mixer takes
// each source's samples as they arrive and drains the saturated sum; with a
// single source it degenerates to a pass-through, so the engine has exactly
// ONE far-end data path instead of a special case per topology.
//
// drainInto() only advances as far as EVERY source has delivered, which is
// why each source must keep pace even when its device is silent or absent —
// the gap filler upstream guarantees that with explicit silence.
class StreamMixer {
 public:
  explicit StreamMixer(int sourceCount);

  void push(int source, const int16_t* samples, size_t count);

  // Mixes min-across-sources pending samples, appends them to `out`, and
  // returns how many that was. Leftovers stay pending for the next drain.
  size_t drainInto(std::vector<int16_t>& out);

 private:
  std::vector<std::vector<int16_t>> pending_;
};

}  // namespace nova::audio
