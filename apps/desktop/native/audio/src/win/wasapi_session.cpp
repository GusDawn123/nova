#include "wasapi_session.h"

#include <array>
#include <string>
#include <utility>
#include <vector>

#include "../core/wire.h"

namespace nova::audio::win {

namespace {

// 200 ms of client-side buffer: shared-mode WASAPI wakes us every ~10 ms, so
// this is 20 periods of slack before the OS would have to drop anything —
// generous cover for scheduling hiccups on a busy machine.
constexpr REFERENCE_TIME kBufferDuration = 2'000'000;  // in 100 ns units

WAVEFORMATEX wireFormat() {
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = 1;
  format.nSamplesPerSec = wire::kSampleRateHz;
  format.wBitsPerSample = 16;
  format.nBlockAlign = static_cast<WORD>(format.nChannels *
                                         (format.wBitsPerSample / 8));
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  return format;
}

}  // namespace

std::unique_ptr<WasapiSession> WasapiSession::open(IMMDevice* device,
                                                   bool loopback,
                                                   const char* name,
                                                   SampleQueue& sink,
                                                   EventSink events) {
  using Microsoft::WRL::ComPtr;

  const auto fail = [&](const char* what, HRESULT hr) {
    events({.type = CaptureEventType::Error,
            .detail = std::string(name) + ": " + describeFailure(what, hr)});
    return nullptr;
  };

  ComPtr<IAudioClient> client;
  HRESULT hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                &client);
  if (FAILED(hr)) {
    return fail("IAudioClient activation failed", hr);
  }

  // AUTOCONVERTPCM makes Windows itself deliver the wire format (16 kHz mono
  // s16) regardless of the device's native rate/channels — the whole reason
  // this repo carries no resampler. SRC_DEFAULT_QUALITY picks the good
  // converter rather than the drift-prone linear one.
  //
  // Platform floor: LOOPBACK + EVENTCALLBACK succeeds but never signals the
  // event before Windows 10 1703 — a capture thread there would block
  // forever. Nova cannot meet that fate: Electron itself requires Windows 10
  // 1809+, which is past the fixed build.
  DWORD flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
  if (loopback) {
    flags |= AUDCLNT_STREAMFLAGS_LOOPBACK;
  }
  WAVEFORMATEX format = wireFormat();
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, kBufferDuration, 0,
                          &format, nullptr);
  if (FAILED(hr)) {
    return fail("IAudioClient initialize failed", hr);
  }

  UniqueHandle samplesReady(CreateEventW(nullptr, FALSE, FALSE, nullptr));
  UniqueHandle stop(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!samplesReady || !stop) {
    return fail("event creation failed",
                HRESULT_FROM_WIN32(GetLastError()));
  }
  hr = client->SetEventHandle(samplesReady.get());
  if (FAILED(hr)) {
    return fail("SetEventHandle failed", hr);
  }

  ComPtr<IAudioCaptureClient> capture;
  hr = client->GetService(IID_PPV_ARGS(&capture));
  if (FAILED(hr)) {
    return fail("IAudioCaptureClient unavailable", hr);
  }

  std::wstring deviceId;
  LPWSTR rawId = nullptr;
  if (SUCCEEDED(device->GetId(&rawId)) && rawId != nullptr) {
    deviceId.assign(rawId);
    CoTaskMemFree(rawId);
  }

  hr = client->Start();
  if (FAILED(hr)) {
    return fail("IAudioClient start failed", hr);
  }

  // Private constructor: reachable only through this factory, and only with
  // every WASAPI step above already proven good.
  return std::unique_ptr<WasapiSession>(new WasapiSession(
      std::move(client), std::move(capture), std::move(samplesReady),
      std::move(stop), name, sink, std::move(events), std::move(deviceId)));
}

WasapiSession::WasapiSession(Microsoft::WRL::ComPtr<IAudioClient> client,
                             Microsoft::WRL::ComPtr<IAudioCaptureClient> capture,
                             UniqueHandle samplesReady, UniqueHandle stop,
                             const char* name, SampleQueue& sink,
                             EventSink events, std::wstring deviceId)
    : client_(std::move(client)),
      capture_(std::move(capture)),
      samplesReady_(std::move(samplesReady)),
      stop_(std::move(stop)),
      name_(name),
      sink_(sink),
      events_(std::move(events)),
      deviceId_(std::move(deviceId)),
      thread_([this] { run(); }) {}

WasapiSession::~WasapiSession() {
  SetEvent(stop_.get());
  if (thread_.joinable()) {
    thread_.join();
  }
  client_->Stop();
}

void WasapiSession::run() {
  ComApartment com;
  const std::array<HANDLE, 2> waits{stop_.get(), samplesReady_.get()};
  std::vector<int16_t> zeros;

  HRESULT hr = S_OK;
  for (;;) {
    const DWORD which = WaitForMultipleObjects(
        static_cast<DWORD>(waits.size()), waits.data(), FALSE, INFINITE);
    if (which == WAIT_OBJECT_0) {
      return;  // stop signalled
    }
    if (which != WAIT_OBJECT_0 + 1) {
      // WAIT_FAILED / WAIT_ABANDONED: this session can no longer hear its
      // device, and it must SAY so — a dead thread with alive_ still true is
      // a slot the self-healing sweep would trust forever.
      alive_.store(false, std::memory_order_relaxed);
      events_({.type = CaptureEventType::DeviceLost,
               .detail = std::string(name_) + ": " +
                         describeFailure("capture wait failed",
                                         HRESULT_FROM_WIN32(GetLastError()))});
      return;
    }

    UINT32 packetFrames = 0;
    hr = capture_->GetNextPacketSize(&packetFrames);
    while (SUCCEEDED(hr) && packetFrames > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD bufferFlags = 0;
      hr = capture_->GetBuffer(&data, &frames, &bufferFlags, nullptr, nullptr);
      if (FAILED(hr)) {
        break;
      }
      // Mono wire format: one frame is one sample.
      if ((bufferFlags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) {
        // The buffer may hold garbage when SILENT is set — substitute zeros.
        zeros.assign(frames, 0);
        sink_.push(zeros.data(), frames);
      } else {
        sink_.push(reinterpret_cast<const int16_t*>(data), frames);
      }
      hr = capture_->ReleaseBuffer(frames);
      if (SUCCEEDED(hr)) {
        hr = capture_->GetNextPacketSize(&packetFrames);
      }
    }

    if (FAILED(hr)) {
      // Typically AUDCLNT_E_DEVICE_INVALIDATED: the device was unplugged.
      // Flag it and bow out; the engine rebuilds around the new defaults and
      // the gap filler keeps the stream's timeline honest meanwhile.
      alive_.store(false, std::memory_order_relaxed);
      events_({.type = CaptureEventType::DeviceLost,
               .detail = std::string(name_) + ": " +
                         describeFailure("capture stream failed", hr)});
      return;
    }
  }
}

}  // namespace nova::audio::win
