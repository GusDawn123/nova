#include <napi.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <utility>

#include "audio_capture.h"
#include "core/wire.h"

// The Node-API surface: start(onBatch, onEvent) / stop(), plus the wire
// format constants so JS never hardcodes them. Node-API (not raw V8) is a
// ratified decision (§5.1): ABI-stable across Node AND Electron versions, so
// this addon also runs under plain `node` — which is exactly how the chunk's
// proof recorder uses it, no Electron required.
namespace {

using nova::audio::AudioCapture;
using nova::audio::CaptureEvent;
using nova::audio::FrameBatch;

// One capture per process. start()/stop() run on the JS thread; the capture
// sinks run on native threads and cross back over the two TSFNs.
struct Engine {
  std::unique_ptr<AudioCapture> capture;
  Napi::ThreadSafeFunction onBatch;
  Napi::ThreadSafeFunction onEvent;
  std::atomic<uint64_t> droppedBatches{0};
};

std::unique_ptr<Engine> engine;

struct EventPayload {
  std::string type;
  std::string detail;
};

// TSFN delivery callbacks. They own their payload (delete it no matter what);
// a null env means the environment is tearing down and there is nobody left
// to deliver to.
void CallBatch(Napi::Env env, Napi::Function callback, FrameBatch* batch) {
  const std::unique_ptr<FrameBatch> owned(batch);
  if (env == nullptr) {
    return;
  }
  auto pcm = Napi::Buffer<int16_t>::Copy(env, owned->samples.data(),
                                         owned->samples.size());
  Napi::Object out = Napi::Object::New(env);
  out.Set("stream", nova::audio::toString(owned->label));
  out.Set("pcm", pcm);
  callback.Call({out});
}

void CallEvent(Napi::Env env, Napi::Function callback, EventPayload* event) {
  const std::unique_ptr<EventPayload> owned(event);
  if (env == nullptr) {
    return;
  }
  Napi::Object out = Napi::Object::New(env);
  out.Set("type", owned->type);
  out.Set("detail", owned->detail);
  callback.Call({out});
}

void Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (engine) {
    throw Napi::Error::New(
        env, "audio capture is already running — call stop() first");
  }
  if (info.Length() < 2 || !info[0].IsFunction() || !info[1].IsFunction()) {
    throw Napi::TypeError::New(env, "start(onBatch, onEvent) — both functions");
  }

  auto next = std::make_unique<Engine>();
  // Bounded queue: if JS stalls, NonBlockingCall starts failing and batches
  // are counted as dropped instead of queueing without limit. 64 batches is
  // ~4 s of audio — recoverable hiccup room, not a memory sink.
  next->onBatch =
      Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(),
                                    "novaAudioBatch", 64, 1);
  next->onEvent =
      Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(),
                                    "novaAudioEvent", 64, 1);
  next->capture = nova::audio::makeAudioCapture();

  Engine* raw = next.get();
  try {
    next->capture->start(
        [raw](FrameBatch&& batch) {
          // Ownership passes to CallBatch on success (it deletes the payload
          // even during environment teardown).
          auto* payload = new FrameBatch(std::move(batch));
          if (raw->onBatch.NonBlockingCall(payload, CallBatch) != napi_ok) {
            delete payload;
            raw->droppedBatches.fetch_add(1, std::memory_order_relaxed);
          }
        },
        [raw](const CaptureEvent& event) {
          auto* payload = new EventPayload{nova::audio::toString(event.type),
                                           event.detail};
          if (raw->onEvent.NonBlockingCall(payload, CallEvent) != napi_ok) {
            // Dropped events are not tracked: they are advisory, audio is not.
            delete payload;
          }
        });
  } catch (...) {
    // A failed start must leave NOTHING behind: no latched engine blocking a
    // retry, no live TSFNs pinning the event loop open forever.
    next->capture->stop();  // idempotent; joins anything half-started
    next->onBatch.Release();
    next->onEvent.Release();
    throw;
  }
  // Published only after start() succeeded, so a throw above cannot strand a
  // half-started engine behind the "already running" guard.
  engine = std::move(next);
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);
  if (!engine) {
    out.Set("droppedBatches", 0);  // idempotent: stopping nothing is fine
    return out;
  }
  // Order matters: stop() joins every native thread first, so no sink can
  // fire after the TSFNs are released.
  engine->capture->stop();
  engine->onBatch.Release();
  engine->onEvent.Release();
  out.Set("droppedBatches",
          Napi::Number::New(
              env, static_cast<double>(engine->droppedBatches.load())));
  engine.reset();
  return out;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));

  Napi::Object wireFormat = Napi::Object::New(env);
  wireFormat.Set("sampleRateHz", nova::audio::wire::kSampleRateHz);
  wireFormat.Set("frameSamples", nova::audio::wire::kFrameSamples);
  wireFormat.Set("framesPerBatch", nova::audio::wire::kFramesPerBatch);
  exports.Set("wireFormat", wireFormat);
  return exports;
}

}  // namespace

NODE_API_MODULE(nova_audio, Init)
