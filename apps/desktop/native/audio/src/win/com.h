#pragma once

#include <objbase.h>

#include <cstdio>
#include <string>

namespace nova::audio::win {

// Every thread that touches a COM interface joins the multithreaded apartment
// for its lifetime. WASAPI objects are shared between the engine thread and
// the capture threads, and MTA is the mode where that is legal.
class ComApartment {
 public:
  ComApartment() : hr_(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {}
  ~ComApartment() {
    if (SUCCEEDED(hr_)) {
      CoUninitialize();
    }
  }
  ComApartment(const ComApartment&) = delete;
  ComApartment& operator=(const ComApartment&) = delete;

  // RPC_E_CHANGED_MODE means the thread already lives in an apartment (the
  // embedder's doing) — COM still works there, so it counts as usable.
  bool ok() const { return SUCCEEDED(hr_) || hr_ == RPC_E_CHANGED_MODE; }

 private:
  HRESULT hr_;
};

// CloseHandle RAII for the Win32 event handles WASAPI signals through.
class UniqueHandle {
 public:
  UniqueHandle() = default;
  explicit UniqueHandle(HANDLE handle) : handle_(handle) {}
  ~UniqueHandle() { reset(); }
  UniqueHandle(UniqueHandle&& other) noexcept : handle_(other.handle_) {
    other.handle_ = nullptr;
  }
  UniqueHandle& operator=(UniqueHandle&& other) noexcept {
    if (this != &other) {
      reset();
      handle_ = other.handle_;
      other.handle_ = nullptr;
    }
    return *this;
  }
  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;

  HANDLE get() const { return handle_; }
  explicit operator bool() const {
    return handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE;
  }
  void reset(HANDLE handle = nullptr) {
    if (*this) {
      CloseHandle(handle_);
    }
    handle_ = handle;
  }

 private:
  HANDLE handle_ = nullptr;
};

// "what failed (hr=0x…)" — the shape every failure detail string uses.
inline std::string describeFailure(const char* what, HRESULT hr) {
  char buffer[160];
  std::snprintf(buffer, sizeof buffer, "%s (hr=0x%08lX)", what,
                static_cast<unsigned long>(hr));
  return buffer;
}

}  // namespace nova::audio::win
