#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

#include "wire.h"

namespace nova::audio {

// Regroups arbitrarily-sized deliveries into exact wire batches. WASAPI hands
// out whatever packet sizes it likes; the wire format promises 20 ms frames
// in ~60 ms batches, and this is the single place where that regrouping
// happens. Emitted batches are bare sample blocks — labelling them is the
// pipeline's job, not the framer's.
class Framer {
 public:
  // Appends complete batches (each exactly wire::kBatchSamples) to `out`.
  // Whatever doesn't fill a batch yet stays pending for the next push.
  void push(const int16_t* samples, size_t count,
            std::vector<std::vector<int16_t>>& out);

 private:
  std::vector<int16_t> pending_;
};

}  // namespace nova::audio
