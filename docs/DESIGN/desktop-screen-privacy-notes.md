# Desktop screen-capture exclusion — clean-room notes

How Nova's desktop window stays out of a screen share while remaining visible on
the user's own display — so a user who shares their screen does not broadcast
their own copilot. Written 2026-08-14 from **public Electron/Apple/Microsoft
documentation and our own testing** — no source from any reference app was read
or copied. The mechanism is a documented public API; the discoveries below are
our own, reproduced from scratch.

---

## TL;DR

- **The mechanism is one line in the MAIN process:** `win.setContentProtection(true)`,
  applied **at window creation**. Not React, not GPU, not a private API.
- **macOS: PROVEN.** On macOS 26.5.2 (Apple Silicon, Electron 43) the window is
  **absent from a live Google Meet full-screen share** and fully visible locally.
- **Windows: PROVEN.** On Windows 11 (build 10.0.26200, Electron 43.4.0) both
  Nova windows disappear from a live screen share when the toggle is on and
  return when it is off — toggled live over IPC, both directions. See
  [Windows](#windows--tested-and-proven).
- Screen-capture exclusion lives in **main**; the React renderer can only *ask*
  main to toggle it over IPC. Putting it in the renderer is impossible and would
  be a security hole.

---

## The mechanism

`win.setContentProtection(enable)` — Electron's documented call, *"prevents the
window contents from being captured by other apps."* It is a thin wrapper over
one OS flag per platform:

| Platform | Under the hood | Status |
|---|---|---|
| macOS | `NSWindowSharingNone` (the window's `sharingType`) | **Proven working, macOS 26.5.2** |
| Windows | `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` (Win10 2004+) | **Proven working, Windows 11 build 10.0.26200 — see below** |

There is **no** app-accessible GPU/Metal hardware overlay plane on macOS. Screen
capture happens in the **WindowServer**, from the same composited buffer that
feeds the display, so the only way to be on-screen-but-not-in-capture is to ask
the WindowServer to exclude the window — which is exactly what this flag does.
The "renders on a GPU layer below capture" story is fabricated and must not enter
any Nova design.

## Architecture: main applies the exclusion, the renderer only asks

Screen-capture exclusion is a main-process concern, the same trust boundary as
the auth token:

- **Main process** owns the window and calls `setContentProtection`. It is the
  only place that can apply the exclusion.
- **Renderer (React)** never applies anything. The closest thing to a "React
  function" for this is a hook — e.g. `useScreenPrivacy()` — that calls a
  preload-exposed `window.api.setScreenPrivacy(true|false)` over IPC. React
  decides *when* (a toggle, a hotkey) and reflects the state in the UI; main does
  the act.

---

## macOS — what we discovered

**Environment:** macOS 26.5.2 (build 25F84), Apple Silicon (arm64), Electron 43.4.0.

**What works:** `win.setContentProtection(true)` **applied at window creation**,
re-asserted once after `ready-to-show`. The window is excluded from the capture
cleanly — the share shows what is *behind* the window, no artifact.

- **Timing matters.** Apply it at creation. In our first pass we toggled it
  lazily over IPC *after* the window was shown (and after another approach had
  mangled the window), and it appeared not to work — a contaminated result.
  Apply at birth and re-assert.
- **Opacity does not matter for this call.** Our probe used a plain opaque
  window and it was still excluded cleanly. (Contrast the failed approach below,
  which is opacity-sensitive.)

**What does NOT work, for the record:**

- **`CGSSetWindowCaptureExcludeShape`** (the private CoreGraphics/WindowServer
  SPI). Its symbols still resolve on macOS 26 and the call returns success, but
  on an opaque Electron window the excluded region renders **grey** in the
  capture rather than see-through — the documented Electron rendering regression
  (electron#46886, why Electron reverted Chromium's implementation). Useless for
  this purpose. Abandoned in favor of `setContentProtection`.
- **Lazily-applied `setContentProtection`** — see the timing note above.

**Correction to our own design doc.** `docs/superpowers/specs/2026-08-11-desktop-pivot-design.md`
§4.1/§4.2 claimed `sharingType`/`setContentProtection` is "dead" on modern macOS.
That is **false** for macOS 26 in the standard static-share case — it works. That
design doc should be amended.

## How we proved macOS worked

1. **Built a clean-room Electron probe** — a visible window with
   `setContentProtection(true)` applied at creation, no other trick in play.
2. **Ran a real screen-share test:** shared the **entire screen** in **Google
   Meet**, and viewed the shared feed on a **second device (a phone joined to the
   same meeting)** — the reliable check, since Meet's own self-preview can lie.
3. **Result:** the probe window was **absent from what the phone saw**, and fully
   visible on the Mac. Cleanly excluded.
4. **Corroboration from a shipped Electron app in this category:** its bundle is
   Electron **40.8.0** with **no native screen-capture addon** (its only native
   module is an unrelated deep-link handler) — so its capture exclusion is the
   same pure-Electron `setContentProtection`. This corroborated our approach.

### Minimal reproduction

```js
// main process — the whole mechanism is one call, applied at creation
const win = new BrowserWindow({
  width, height,
  alwaysOnTop: true,
  skipTaskbar: true,
  // for a real overlay: frame: false, transparent: true,
  // macOS overlay niceties: type: 'panel', hiddenInMissionControl: true,
  webPreferences: { contextIsolation: true, nodeIntegration: false, preload },
});
win.setContentProtection(true);                 // <-- excludes from screen capture
win.setAlwaysOnTop(true, 'screen-saver');
win.once('ready-to-show', () => win.setContentProtection(true)); // re-assert
```

Test: share the entire screen in Google Meet (or Zoom), view from a second
device, confirm the window is absent there and present locally.

---

## The broader window-privacy options

Screen-capture exclusion is one piece. The rest is a small set of
**main-process** `BrowserWindow` options — none of them React:

| Goal | Option / call | Notes |
|---|---|---|
| Excluded from screen capture | `setContentProtection(true)` | the core one |
| Not in the Windows taskbar / switcher | `skipTaskbar: true` | no-op on macOS |
| No macOS dock icon | `app.dock.hide()` / `LSUIElement` | menu-bar-less agent app |
| Float over fullscreen apps (macOS) | `type: 'panel'` | appears on all spaces |
| Not shown during Mission Control | `hiddenInMissionControl: true` | macOS |
| No window chrome | `frame: false`, `transparent: true` | overlay look |
| Never steal focus from the call | non-activating window config | so the meeting app stays frontmost |
| Generic window title | generic window title / process name | keeps the product name out of the title bar |

---

## Windows — tested and proven

`setContentProtection(true)` maps to `SetWindowDisplayAffinity(hwnd,
WDA_EXCLUDEFROMCAPTURE)`, real and documented on Windows 10 version 2004+.

**The risk (from the pivot research, §4.2):** there are reports that on Windows
11 this call **does not take effect for Chromium/Electron-class windows** while
succeeding for classic Win32 apps — acknowledged by a Microsoft engineer. So the
macOS result does **not** automatically carry over. If it does not work on
Windows, the difficulty has *flipped*: macOS becomes the easy platform and
Windows needs a workaround.

**How to test (must be real hardware, not a VM):**

1. Run an Electron window with `setContentProtection(true)` on the target
   Windows 11 machine. A VM's virtualized display path is not a trustworthy proof.
2. Share the **entire screen** in Google Meet (or Zoom), view from a second device.
3. **Pass:** the window is absent from the shared feed, visible locally.
   **Fail:** it shows in the share.
4. Record the result here (Windows version/build, Electron version, outcome).

**Windows result: WORKS (2026-08-15 — Gustavo, real hardware).** Windows 11
Home (build 10.0.26200), Electron 43.4.0, the real Nova desktop app (pill +
settings windows). `setContentProtection` toggled **live over IPC** — not only
at creation: with the toggle ON both windows are absent from the screen share;
with it OFF both appear; both directions repeatable mid-share. This also
retires the §4.2 risk for this machine — the "fails for Chromium-class windows
on Win11" report did not reproduce — and shows the lazy-apply path works on
Windows (the macOS timing note above stands unrevisited).

---

## Open edges to stress-test (both platforms)

- **Mid-session capture-filter change** (macOS ScreenCaptureKit bug FB21115847):
  an excluded window can be omitted on a fresh capture filter and *re-appear*
  after the filter updates mid-call (e.g. switching what is shared). Test whether
  the window stays excluded across a mid-call share change. This is the case a
  read-back/watchdog (re-assert on reset events) would catch.
- Neither Apple nor Microsoft guarantees these flags as a security feature; they
  can lose to some capture paths and OS versions. Treat screen-capture exclusion
  as best-effort and verify per platform/OS release.

---

## Clean-room / license

This mechanism is a documented public Electron API, validated by our own testing.
We do not copy code from any reference implementation. Nova's screen-capture
exclusion is built from the Electron/Apple/Microsoft documentation and the
results recorded here.
