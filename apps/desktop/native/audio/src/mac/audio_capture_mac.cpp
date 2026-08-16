#include <memory>

#include "../audio_capture.h"

// Signature-complete stand-in, per the chunk list's scaffolding rule (§6:
// "the macOS branch of each port is created as a signature-complete stub in
// the same chunk that creates the Windows one"). The real implementation —
// CoreAudio process tap (14.4+) / ScreenCaptureKit (13+) — is chunk 8+, and
// slots in by replacing this file's makeAudioCapture() only.
namespace nova::audio {
namespace {

class MacAudioCapture final : public AudioCapture {
 public:
  void start(BatchSink /*onBatch*/, EventSink onEvent) override {
    onEvent({.type = CaptureEventType::Error,
             .detail = "macOS audio capture is not implemented yet (chunk 8+)"});
  }
  void stop() override {}
};

}  // namespace

std::unique_ptr<AudioCapture> makeAudioCapture() {
  return std::make_unique<MacAudioCapture>();
}

}  // namespace nova::audio
