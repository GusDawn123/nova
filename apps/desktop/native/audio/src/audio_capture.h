#pragma once

#include <functional>
#include <memory>

#include "core/capture_events.h"
#include "core/stream.h"

namespace nova::audio {

using BatchSink = std::function<void(FrameBatch&&)>;

// The AudioCapture port — the one boundary the OS lives behind (§3 module
// discipline: nothing above this line knows WASAPI from CoreAudio).
//
// start() cannot fail structurally, on purpose: almost everything that can go
// wrong (no mic YET, headphones unplugged mid-call, defaults switched) is
// transient, and the engine's job is to ride it out — streaming gap-filled
// silence and reporting through the EventSink until the hardware comes back.
// Both sinks are invoked from internal capture threads, never the caller's.
class AudioCapture {
 public:
  virtual ~AudioCapture() = default;
  AudioCapture(const AudioCapture&) = delete;
  AudioCapture& operator=(const AudioCapture&) = delete;

  virtual void start(BatchSink onBatch, EventSink onEvent) = 0;

  // Idempotent; joins every internal thread before returning, so no sink is
  // ever invoked after stop() returns.
  virtual void stop() = 0;

 protected:
  AudioCapture() = default;
};

// Each platform's shell (src/win, src/mac) defines this factory for itself.
std::unique_ptr<AudioCapture> makeAudioCapture();

}  // namespace nova::audio
