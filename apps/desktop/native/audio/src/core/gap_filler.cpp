#include "gap_filler.h"

#include <algorithm>

namespace nova::audio {

namespace {
GapFiller::Config clamped(GapFiller::Config config) {
  // A refill target above the tolerance would mean filling PAST the trigger
  // point — nonsensical, so the target is capped at the tolerance.
  config.refillTargetSamples =
      std::min(config.refillTargetSamples, config.toleranceSamples);
  return config;
}
}  // namespace

GapFiller::GapFiller(Config config) : config_(clamped(config)) {}

void GapFiller::setConfig(Config config) { config_ = clamped(config); }

size_t GapFiller::advance(size_t wallSamples, size_t arrived) {
  // Credit what arrived first: a burst that covers the gap means the gap no
  // longer exists, and filling it anyway would both inject spurious silence
  // and push the stream past the wall — a surplus the mixer would then hold
  // against the wall-paced slot for the rest of the call.
  position_ += arrived;
  size_t fill = 0;
  if (wallSamples > position_) {
    const size_t deficit = wallSamples - position_;
    if (deficit > config_.toleranceSamples) {
      fill = deficit - config_.refillTargetSamples;
    }
  }
  position_ += fill;
  injected_ += fill;
  return fill;
}

}  // namespace nova::audio
