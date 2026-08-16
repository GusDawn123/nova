#include "framer.h"

namespace nova::audio {

void Framer::push(const int16_t* samples, size_t count,
                  std::vector<std::vector<int16_t>>& out) {
  pending_.insert(pending_.end(), samples, samples + count);
  size_t offset = 0;
  while (pending_.size() - offset >= wire::kBatchSamples) {
    out.emplace_back(pending_.begin() + static_cast<std::ptrdiff_t>(offset),
                     pending_.begin() +
                         static_cast<std::ptrdiff_t>(offset) +
                         wire::kBatchSamples);
    offset += wire::kBatchSamples;
  }
  // What remains is always < one batch, so this erase moves < 960 samples.
  pending_.erase(pending_.begin(),
                 pending_.begin() + static_cast<std::ptrdiff_t>(offset));
}

}  // namespace nova::audio
