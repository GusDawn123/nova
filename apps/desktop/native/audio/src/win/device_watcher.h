#pragma once

#include <mmdeviceapi.h>

#include <atomic>
#include <functional>
#include <utility>

namespace nova::audio::win {

// Fires `onChange` whenever the machine's audio device landscape moves —
// defaults switching, endpoints arriving or leaving. This is what makes
// plugging in headphones mid-call a non-event instead of a dead recording.
//
// Callbacks arrive on COM worker threads. `onChange` must therefore do almost
// nothing: the engine's callback just sets an atomic flag it polls on its own
// tick, which also absorbs Windows' habit of announcing one physical change
// as a burst of notifications.
class DeviceWatcher final : public IMMNotificationClient {
 public:
  explicit DeviceWatcher(std::function<void()> onChange)
      : onChange_(std::move(onChange)) {}

  // IUnknown
  ULONG STDMETHODCALLTYPE AddRef() override {
    return refs_.fetch_add(1) + 1;
  }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG remaining = refs_.fetch_sub(1) - 1;
    if (remaining == 0) {
      delete this;
    }
    return remaining;
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid,
                                           void** object) override {
    if (object == nullptr) {
      return E_POINTER;
    }
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IMMNotificationClient)) {
      *object = static_cast<IMMNotificationClient*>(this);
      AddRef();
      return S_OK;
    }
    *object = nullptr;
    return E_NOINTERFACE;
  }

  // IMMNotificationClient
  HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow, ERole,
                                                   LPCWSTR) override {
    onChange_();
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR) override {
    onChange_();
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR) override {
    onChange_();
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR, DWORD) override {
    onChange_();
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR,
                                                   const PROPERTYKEY) override {
    // Fires constantly (volume nudges, driver chatter) — never a reason to
    // rebuild capture sessions.
    return S_OK;
  }

 private:
  ~DeviceWatcher() = default;  // heap-only: Release() is the destroyer

  std::atomic<ULONG> refs_{1};
  std::function<void()> onChange_;
};

}  // namespace nova::audio::win
