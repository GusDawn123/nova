#include "stream_mixer.h"

#include <algorithm>
#include <cassert>
#include <limits>

namespace nova::audio {

StreamMixer::StreamMixer(int sourceCount) {
  assert(sourceCount >= 1);
  pending_.resize(static_cast<size_t>(sourceCount));
}

void StreamMixer::push(int source, const int16_t* samples, size_t count) {
  assert(source >= 0 && static_cast<size_t>(source) < pending_.size());
  auto& pending = pending_[static_cast<size_t>(source)];
  pending.insert(pending.end(), samples, samples + count);
}

size_t StreamMixer::drainInto(std::vector<int16_t>& out) {
  size_t ready = pending_.front().size();
  for (const auto& pending : pending_) {
    ready = std::min(ready, pending.size());
  }
  if (ready == 0) {
    return 0;
  }
  // Both branches below were the profiler's #1 hotspot as a naive per-sample
  // push_back loop; reserving once and bulk-copying the single-source case
  // (every "me" drain) is what the profile asked for.
  out.reserve(out.size() + ready);
  if (pending_.size() == 1) {
    const auto& only = pending_.front();
    out.insert(out.end(), only.begin(),
               only.begin() + static_cast<std::ptrdiff_t>(ready));
  } else {
    for (size_t i = 0; i < ready; ++i) {
      // Sum in 32-bit and saturate: two loud far ends must clip, not wrap.
      int32_t sum = 0;
      for (const auto& pending : pending_) {
        sum += pending[i];
      }
      out.push_back(static_cast<int16_t>(
          std::clamp<int32_t>(sum, std::numeric_limits<int16_t>::min(),
                              std::numeric_limits<int16_t>::max())));
    }
  }
  for (auto& pending : pending_) {
    pending.erase(pending.begin(),
                  pending.begin() + static_cast<std::ptrdiff_t>(ready));
  }
  return ready;
}

}  // namespace nova::audio
