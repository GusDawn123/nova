#pragma once

#include <audioclient.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>

#include <atomic>
#include <memory>
#include <string>
#include <thread>

#include "../core/capture_events.h"
#include "../core/sample_queue.h"
#include "com.h"

namespace nova::audio::win {

// One WASAPI capture session on one endpoint: the mic directly, or a render
// endpoint in loopback (which is how Windows exposes "what the machine is
// playing"). Owns exactly one capture thread; every sample it hears lands in
// the SampleQueue it was given, already in wire format — the session asks
// Windows to convert (AUTOCONVERTPCM), so no resampler lives in this repo.
class WasapiSession {
 public:
  // Returns nullptr on failure, reporting the reason through `events` first.
  // `name` is the human name used in event details ("microphone", …).
  static std::unique_ptr<WasapiSession> open(IMMDevice* device, bool loopback,
                                             const char* name,
                                             SampleQueue& sink,
                                             EventSink events);

  ~WasapiSession();
  WasapiSession(const WasapiSession&) = delete;
  WasapiSession& operator=(const WasapiSession&) = delete;

  // Flips false when the device dies mid-stream (unplugged, invalidated);
  // the engine notices and rebuilds around the new defaults.
  bool alive() const { return alive_.load(std::memory_order_relaxed); }

  const std::wstring& deviceId() const { return deviceId_; }

 private:
  WasapiSession(Microsoft::WRL::ComPtr<IAudioClient> client,
                Microsoft::WRL::ComPtr<IAudioCaptureClient> capture,
                UniqueHandle samplesReady, UniqueHandle stop, const char* name,
                SampleQueue& sink, EventSink events, std::wstring deviceId);

  void run();

  Microsoft::WRL::ComPtr<IAudioClient> client_;
  Microsoft::WRL::ComPtr<IAudioCaptureClient> capture_;
  UniqueHandle samplesReady_;
  UniqueHandle stop_;
  const char* name_;
  SampleQueue& sink_;
  EventSink events_;
  std::wstring deviceId_;
  std::atomic<bool> alive_{true};
  std::thread thread_;
};

}  // namespace nova::audio::win
