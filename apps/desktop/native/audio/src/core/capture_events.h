#pragma once

#include <functional>
#include <string>

namespace nova::audio {

// Capture rides problems out rather than dying on them — a call copilot that
// stops recording when headphones get plugged in looks broken at the worst
// possible moment. So everything that goes wrong flows through this channel
// while the streams keep time with injected silence, and the embedder decides
// what is worth telling the user.
enum class CaptureEventType {
  DeviceChanged,   // a default device moved; capture followed it
  DeviceLost,      // a device died or is absent; its slot streams silence
  DeviceRestored,  // a lost or missing device is being captured again
  Overflow,        // the consumer stalled; incoming audio had to be dropped
  Error,           // a failure a rebuild cannot fix by itself
};

inline constexpr const char* toString(CaptureEventType type) {
  switch (type) {
    case CaptureEventType::DeviceChanged:
      return "device-changed";
    case CaptureEventType::DeviceLost:
      return "device-lost";
    case CaptureEventType::DeviceRestored:
      return "device-restored";
    case CaptureEventType::Overflow:
      return "overflow";
    case CaptureEventType::Error:
      return "error";
  }
  return "unknown";
}

struct CaptureEvent {
  CaptureEventType type;
  std::string detail;
};

using EventSink = std::function<void(const CaptureEvent&)>;

}  // namespace nova::audio
