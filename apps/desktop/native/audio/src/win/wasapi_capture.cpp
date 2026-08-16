#include <mmdeviceapi.h>
#include <wrl/client.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "../audio_capture.h"
#include "../core/stream_pipeline.h"
#include "../core/wire.h"
#include "com.h"
#include "device_watcher.h"
#include "wasapi_session.h"

// The Windows engine behind the AudioCapture port. One thread ticking at
// frame rate; per tick it advances both stream pipelines against the wall
// clock and, when the device landscape moved, rebuilds capture sessions
// around the current defaults. Everything device-shaped lives HERE — the
// pipelines never learn what a device is.
namespace nova::audio {
namespace {

using Microsoft::WRL::ComPtr;

// Engine cadence: one wire frame. Batches still leave at their own ~60 ms
// rhythm (the framer owns that); a fast tick just keeps added latency and
// device-rebuild reaction time small.
constexpr auto kTickPeriod = std::chrono::milliseconds(20);
// Windows announces one physical change as a burst of notifications;
// rebuilding on each would thrash. Quiet time required before acting:
constexpr auto kRebuildDebounce = std::chrono::milliseconds(300);
// The self-healing sweep: re-resolve defaults this often regardless, so a
// missed notification or a failed open can never strand a slot forever.
constexpr auto kSweepPeriod = std::chrono::milliseconds(1000);
// A consumer stall drops audio continuously; one event per stretch is news,
// fifty a second is noise.
constexpr auto kOverflowReportPeriod = std::chrono::seconds(5);

size_t wallSamples(std::chrono::steady_clock::duration elapsed) {
  const auto us =
      std::chrono::duration_cast<std::chrono::microseconds>(elapsed).count();
  return static_cast<size_t>(us * wire::kSampleRateHz / 1'000'000);
}

// One desired endpoint: which default it follows and where its audio lands.
struct Slot {
  const char* name;  // for event details
  EDataFlow flow;
  ERole role;
  bool loopback;
  StreamPipeline* pipeline;
  int source;
  // A slot that must NOT capture when its default equals another slot's
  // (same physical device = its audio is already on that slot's loopback,
  // and a second session would double it). -1 = no dedupe.
  int dedupeAgainstSlot = -1;

  std::unique_ptr<win::WasapiSession> session;
  std::wstring trackedId;  // device the live session follows ("" = none)
  bool reportedMissing = false;  // tell a missing device once, not once a tick
};

class WasapiCapture final : public AudioCapture {
 public:
  ~WasapiCapture() override { stop(); }

  void start(BatchSink onBatch, EventSink onEvent) override {
    if (engine_.joinable()) {
      return;  // already running — the binding prevents this; stay safe anyway
    }
    onBatch_ = std::move(onBatch);
    onEvent_ = std::move(onEvent);
    {
      std::lock_guard<std::mutex> lock(mutex_);
      stopRequested_ = false;
    }
    engine_ = std::thread([this] { run(); });
  }

  void stop() override {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      stopRequested_ = true;
    }
    cv_.notify_all();
    if (engine_.joinable()) {
      engine_.join();
      engine_ = std::thread();
    }
  }

 private:
  void run();
  void rebuild(IMMDeviceEnumerator* enumerator, std::vector<Slot>& slots,
               bool firstBuild);

  BatchSink onBatch_;
  EventSink onEvent_;
  std::thread engine_;
  std::mutex mutex_;
  std::condition_variable cv_;
  bool stopRequested_ = false;
};

void WasapiCapture::run() {
  win::ComApartment com;
  if (!com.ok()) {
    onEvent_({CaptureEventType::Error,
              "COM initialization failed — audio capture cannot run"});
    return;
  }

  ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
                                CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
  if (FAILED(hr)) {
    onEvent_({CaptureEventType::Error,
              win::describeFailure("device enumerator unavailable", hr)});
    return;
  }

  // The watcher's callback runs on COM worker threads — it only pokes this
  // flag; the tick loop does the actual (debounced) reacting.
  std::atomic<bool> devicesDirty{false};
  ComPtr<win::DeviceWatcher> watcher;
  watcher.Attach(new win::DeviceWatcher([&devicesDirty] {
    devicesDirty.store(true, std::memory_order_relaxed);
  }));
  enumerator->RegisterEndpointNotificationCallback(watcher.Get());

  StreamPipeline me(StreamLabel::Me, 1);
  StreamPipeline them(StreamLabel::Them, 2);

  // The three endpoints Nova follows (§6 chunk 2): the communications mic —
  // the one calls actually use — and BOTH render roles, because Zoom routes
  // to the communications device while media plays on the multimedia one.
  std::vector<Slot> slots;
  slots.push_back({"microphone", eCapture, eCommunications, false, &me, 0});
  slots.push_back(
      {"system audio (default output)", eRender, eConsole, true, &them, 0});
  slots.push_back({"system audio (communications output)", eRender,
                   eCommunications, true, &them, 1, /*dedupeAgainstSlot=*/1});

  rebuild(enumerator.Get(), slots, /*firstBuild=*/true);

  const auto startedAt = std::chrono::steady_clock::now();
  auto lastSweep = startedAt;
  auto lastOverflowReport = startedAt - kOverflowReportPeriod;
  std::optional<std::chrono::steady_clock::time_point> dirtySince;
  std::vector<FrameBatch> batches;
  size_t reportedDrops = 0;

  for (;;) {
    {
      std::unique_lock<std::mutex> lock(mutex_);
      cv_.wait_for(lock, kTickPeriod, [this] { return stopRequested_; });
      if (stopRequested_) {
        break;
      }
    }
    const auto now = std::chrono::steady_clock::now();

    // A notification burst keeps pushing the quiet timer out; one change =
    // one rebuild.
    if (devicesDirty.exchange(false, std::memory_order_relaxed)) {
      dirtySince = now;
    }
    const bool debounceExpired =
        dirtySince.has_value() && now - *dirtySince >= kRebuildDebounce;
    if (debounceExpired || now - lastSweep >= kSweepPeriod) {
      rebuild(enumerator.Get(), slots, /*firstBuild=*/false);
      if (debounceExpired) {
        dirtySince.reset();
      }
      lastSweep = now;
    }

    batches.clear();
    const size_t wall = wallSamples(now - startedAt);
    me.tick(wall, batches);
    them.tick(wall, batches);
    for (auto& batch : batches) {
      onBatch_(std::move(batch));
    }

    const size_t drops =
        me.stats().droppedSamples + them.stats().droppedSamples;
    if (drops > reportedDrops &&
        now - lastOverflowReport >= kOverflowReportPeriod) {
      onEvent_({CaptureEventType::Overflow,
                "consumer stalled; dropped " +
                    std::to_string(drops - reportedDrops) +
                    " samples (timeline stays correct via silence backfill)"});
      reportedDrops = drops;
      lastOverflowReport = now;
    }
  }

  enumerator->UnregisterEndpointNotificationCallback(watcher.Get());
  slots.clear();  // joins every capture thread
}

void WasapiCapture::rebuild(IMMDeviceEnumerator* enumerator,
                            std::vector<Slot>& slots, bool firstBuild) {
  for (auto& slot : slots) {
    ComPtr<IMMDevice> device;
    std::wstring id;
    if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(slot.flow, slot.role,
                                                      &device))) {
      LPWSTR rawId = nullptr;
      if (SUCCEEDED(device->GetId(&rawId)) && rawId != nullptr) {
        id.assign(rawId);
        CoTaskMemFree(rawId);
      }
    }

    // Both roles on one physical device → the other slot's loopback already
    // hears this audio; capturing it twice would double the far end.
    const bool duplicate =
        slot.dedupeAgainstSlot >= 0 && !id.empty() &&
        id == slots[static_cast<size_t>(slot.dedupeAgainstSlot)].trackedId;
    if (duplicate) {
      id.clear();
    }

    if (slot.session && slot.session->alive() && !id.empty() &&
        slot.session->deviceId() == id) {
      continue;  // healthy and still pointed at the right device
    }

    const bool hadSession = slot.session != nullptr;
    slot.session.reset();
    slot.pipeline->setSourceLive(slot.source, false);
    slot.trackedId.clear();

    if (id.empty()) {
      if (!duplicate && !slot.reportedMissing) {
        onEvent_({CaptureEventType::DeviceLost,
                  std::string(slot.name) +
                      ": no default device — streaming silence until one "
                      "appears"});
        slot.reportedMissing = true;
      }
      continue;
    }

    slot.session = win::WasapiSession::open(device.Get(), slot.loopback,
                                            slot.name,
                                            slot.pipeline->queue(slot.source),
                                            onEvent_);
    if (!slot.session) {
      continue;  // open() reported why; the sweep will retry in a second
    }
    slot.trackedId = id;
    slot.pipeline->setSourceLive(slot.source, true);
    slot.reportedMissing = false;
    if (!firstBuild) {
      onEvent_({hadSession ? CaptureEventType::DeviceChanged
                           : CaptureEventType::DeviceRestored,
                std::string(slot.name) +
                    ": now capturing the current default device"});
    }
  }
}

}  // namespace

std::unique_ptr<AudioCapture> makeAudioCapture() {
  return std::make_unique<WasapiCapture>();
}

}  // namespace nova::audio
