#pragma once

#include <cstddef>

#include "wire.h"

namespace nova::audio {

// WASAPI loopback goes completely quiet when nothing is playing — no packets,
// not even zeros — and a stream recorded verbatim would compress that dead
// air out of the timeline. The gap filler owns the stream's position instead:
// advance() is told how far the wall clock has come and how many real samples
// arrived, and answers how many silence samples the caller must write to keep
// the timeline truthful.
//
// The tolerance is hysteresis, not sloppiness. Healthy delivery always trails
// the wall clock by a device period or two of jitter; filling THAT in would
// stuff zeros into live speech. Only a deficit no healthy stream ever shows
// counts as a real gap, and it is refilled down to `refillTargetSamples`
// rather than to zero so delivery resuming right after a fill doesn't
// oscillate around the threshold.
class GapFiller {
 public:
  struct Config {
    size_t toleranceSamples;     // deficit that counts as a real gap
    size_t refillTargetSamples;  // deficit deliberately left after a fill
  };

  // 200 ms before a deficit is a gap; refills leave 100 ms in place.
  static constexpr Config kWireDefaults{wire::kSampleRateHz / 5,
                                        wire::kSampleRateHz / 10};

  // Zero tolerance: every tick fills straight up to the wall clock. This is
  // the mode for a slot with no device behind it — pure explicit silence.
  static constexpr Config kFillEverything{0, 0};

  explicit GapFiller(Config config = kWireDefaults);

  // Reconfigurable in place so a device coming or going never resets the
  // stream position — a fresh filler would mistake the whole call so far for
  // one giant gap and flood silence to "catch up".
  void setConfig(Config config);

  // `wallSamples`: how many samples the wall clock says should exist by now.
  // `arrived`: real samples that just landed. Returns the silence owed, which
  // the caller writes BEFORE the arrived samples — a gap being repaired
  // predates the audio that just came in.
  size_t advance(size_t wallSamples, size_t arrived);

  size_t injectedTotal() const { return injected_; }

 private:
  Config config_;
  size_t position_ = 0;
  size_t injected_ = 0;
};

}  // namespace nova::audio
