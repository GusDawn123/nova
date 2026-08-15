# Desktop native — field notes

Research gathered 2026-08-11 for the desktop pivot
([design doc](../superpowers/specs/2026-08-11-desktop-pivot-design.md)).

## What this file is, and the rule that governs it

These are **field notes**, not a plan and not a library. They record *which OS
APIs to call, in what order, and what breaks* — the expensive knowledge that is
invisible in any vendor's documentation because it only shows up in production.

They were gathered by studying a reference Electron overlay app that is licensed
**AGPL-3.0**. Nova is closed-source and commercial.

> **Binding rule for every implementer.** Architecture, OS API selection, call
> ordering, and known failure modes are facts, not expression — they are safe to
> know and are recorded here. **No source from that project may be copied,
> translated, or adapted into this repo.** Build from Apple, Microsoft, and
> Electron documentation. If you find yourself with their file open next to your
> editor, close it.

The reference implementation is **Rust**; ours is **C++ over Node-API**. Nothing
below is a port.

---

## 1. System audio + microphone — chunk 2

**Consent and disclosure.** What follows is the same capture any meeting
notetaker performs: the user's own microphone plus the system output on the
user's own machine, both under OS permission grants the user makes explicitly
(§4.4 of the design doc). Disclosure to the other party is a product
requirement — the app must show a visible in-call recording state, and
onboarding must tell the user they are responsible for disclosure wherever their
jurisdiction requires it. Nothing is captured when no session is running.

### 1.1 macOS: two paths, one version cliff

| | CoreAudio process tap | ScreenCaptureKit |
|---|---|---|
| Minimum OS | **14.4** | **13.0** |
| Screen Recording prompt | no | **yes** |
| Device selection | yes, per output device | no — global system audio only |
| Preference | primary | fallback |

**The version cliff is a crash, not a failure.** The `CATapDescription` *class*
exists from macOS 14.2, but the initializer we need shipped in 14.4. On 14.2 and
14.3, allocation succeeds and the selector then throws — which tears down the
process before any fallback can run. **Gate on the OS version at runtime**
(`NSProcessInfo.isOperatingSystemAtLeastVersion`), never on whether the symbol
resolves. Same shape applies to the SCK path at 13.0.

**Two HAL requirements that produce silent zero-filled audio when missed:**

- Bind the tap to the **specific output device UID**. Left global, the aggregate
  device starts "successfully" and delivers nothing but zeros.
- The aggregate-device descriptor must name that same UID in **both**
  `main_sub_device` **and** inside `sub_device_list`. Naming it once leaves the
  main sub-device empty, and again the tap starts and produces nothing.

**Take the sample rate from the tap's ASBD, never from the aggregate device's
clock.** The process tap always runs at the ASBD rate (usually 48 kHz). If a
Bluetooth device reports an HFP rate (24 kHz) and you trust *that*, the STT
vendor decodes 48 kHz samples at 24 kHz and every transcript comes back as
slow-motion garble.

**The CoreAudio aggregate device cannot be resumed** — pause is one-way. Destroy
and recreate.

**ScreenCaptureKit has no audio-only stream.** You configure a minimal video
stream (2×2 px, 1 fps) alongside the audio you actually want. Set
`excludesCurrentProcessAudio` so our own output cannot feed back. Budget
**5–10 seconds** for first audio on this path — a watchdog tighter than that
false-fires on legitimate cold start.

### 1.2 Windows: WASAPI loopback

The idiom is a **render** endpoint opened in **capture** direction, **shared**
mode, with `AUDCLNT_STREAMFLAGS_LOOPBACK | EVENTCALLBACK`. Requesting format
conversion (`AUTOCONVERTPCM`) is what gets mono float32 out of a stereo device —
the OS mixer does the downmix, we do not. Note that auto-convert is illegal in
exclusive mode, so **loopback and exclusive mode are mutually exclusive**.

**A wait timeout on the loopback event is normal, not an error.** WASAPI fires no
events during silence. Treat timeout as "keep going" and rely on a higher-level
watchdog to detect genuine death.

**The bug we must not inherit: Windows has two default output devices.** The
`eMultimedia`/`eConsole` default (media) and the `eCommunications` default
(calls) are configured independently, and Zoom, Teams, Discord and Meet commonly
route to the *communications* one. Binding only the multimedia default means the
loopback records **silence for the entire meeting**. The reference
implementation has exactly this hole and documents it as unfixed. Handle both
roles from day one — it needs `IMMDeviceEnumerator` directly.

### 1.3 Route changes, Bluetooth, sleep

- **Poll the platform default-output id (~4 s) and rebuild the capture on
  change** — neither backend follows a route switch. Rebuild with **no pinned
  device**, or the next switch breaks it again.
- **macOS: native mic rate ≤ 24 kHz means Bluetooth dropped into HFP call
  mode.** Switch to the built-in mic automatically, keeping the Bluetooth device
  as A2DP output. Device *names* are useless here — the OS reports "Default
  Microphone".
- **macOS: the same device cannot be both input and output.** A tap on a device
  that is simultaneously the active mic initializes fine and yields zero frames
  forever. Detect it by resolving the CoreAudio output UID to a name and
  comparing to the input device name, then auto-switch or tell the user plainly.
- **Rebuild every capture on system resume, and reset all recovery counters
  first.** Sleep silently invalidates the CoreAudio handle with no notification;
  a saturated retry counter will swallow the one transient error you needed.

### 1.4 The dominant failure mode: silence, not errors

macOS returns **zero-filled buffers** rather than an error when a Screen
Recording grant no longer applies to the running binary — which happens routinely
after a dev rebuild changes the signature. Two detectors are mandatory:

- **No-chunks watchdog**, ~12 s, armed on start and disarmed synchronously on
  stop (not via an event, which can arrive too late).
- **Zero-fill detector**: track **peak-to-peak**, not absolute peak — USB and
  Bluetooth devices carry DC bias that defeats an abs-peak check. Latch the
  detector permanently off on the first genuinely loud chunk.

### 1.5 The audio callback and the Node boundary

- **Keep the audio callback genuinely lock-free.** Push to a bounded SPSC ring
  and return. (The reference implementation locks a mutex to signal a condition
  variable nothing waits on — a mistake worth not copying.)
- **Count and surface ring overruns.** Discarding the push result makes drops
  invisible, and a consumer stall becomes an unexplained transcription gap.
- **Batch ~3 × 20 ms frames per crossing into JS**, with a ~100 ms partial-batch
  timeout. At 50 chunks/sec the per-call boundary cost dominates.
- **Flush the batch before emitting end-of-speech or an error**, so the vendor
  sees trailing consonants before it is told the utterance ended.
- **Start must return immediately** — device and permission init takes 5–10 s on
  the SCK path and cannot block the main thread.
- **Destroy and recreate capture objects; never stop-then-start.** Reusing a
  torn-down handle yields a stream that looks alive and produces nothing.
- **Make teardown awaitable and idempotent, and serialise every rebuild path
  behind one mutex.** Two flows that each destroy-and-recreate will interleave
  across an `await`, orphaning a live instance that still holds the tap and
  double-feeds the transcriber.

### 1.6 Voice activity and silence

Sitting before the STT vendor, this is mostly a **cost** control, and it must
never delay speech.

- **Never delay speech frames.** Put the entire cost in the hangover tail
  (~500–600 ms).
- **Asymmetric configuration:** ML-VAD **on** for the microphone, **off** for
  system audio. Music, games, and non-human sound get suppressed to death
  otherwise.
- **Adapt the noise floor only while confirmed-silent**, or the threshold drifts
  up above the speaker.
- **Emit periodic zero-filled keepalive frames during suppression** to hold
  streaming sockets open — then be ready to strip them per vendor. At least one
  major STT vendor hallucinates interim tokens ("he", "heh") from interleaved
  real-audio and silence.

### 1.7 Resampling

Do it **once, centrally**, with a real anti-aliased polyphase/FFT resampler —
not index-stepping decimation. Test it with a tone-and-alias measurement,
including the non-integer 24 k→16 k Bluetooth case.

**Whatever rate you emit must be the rate you declare to the vendor.** Build the
"resampler failed → fall back to passthrough **and correct the declared rate**"
path before shipping. A silent mismatch shows up as chipmunk transcription, never
as an error.

### 1.8 Echo

There is **no acoustic echo cancellation** in the reference design, and none
planned for Nova v1. This is correct for headphones and broken on open speakers,
where the far end lands in both streams and is transcribed twice. State it in
onboarding; revisit deliberately.

---

## 2. Overlay window and focus — chunk 4

### 2.1 macOS: five layers, none sufficient alone

1. The window must be a **panel** (`NSPanel`), not a plain window. This is a hard
   prerequisite: `becomesKeyOnlyIfNeeded` and the activation SPI silently no-op
   on a plain `NSWindow` because `respondsToSelector:` returns false. The
   reference project shipped a "fix" that did nothing for exactly this reason.
2. **`becomesKeyOnlyIfNeeded = YES`** — the load-bearing one. Clicks promote the
   panel to key only when they land on something that genuinely needs key (a text
   field). Without it, clicking any button on the overlay visibly dims the user's
   Zoom window.
3. **`hidesOnDeactivate = NO`** — otherwise macOS auto-hides the panel the moment
   another app activates.
4. **`collectionBehavior = CanJoinAllSpaces | FullScreenAuxiliary | IgnoresCycle`.**
   `FullScreenAuxiliary` is specifically what renders the overlay above another
   app's fullscreen window without our going fullscreen. **Do not add
   `Stationary`** — it contradicts `CanJoinAllSpaces` and on Sonoma 14.4+ makes
   the panel vanish from secondary Spaces.
5. **`_setPreventsActivation:` (private SPI), behind a `respondsToSelector:`
   guard.** The nonactivating style mask lives in two places — AppKit's NSWindow
   *and* the WindowServer's per-window tag bitmap — and setting the mask after
   window init fails to resync the tag. The window then looks nonactivating to
   AppKit while the WindowServer still treats clicks as app-activating. Public
   API alone gets ~90% of the behaviour.

**Re-apply everything after any `setStyleMask:` call** — it resets the
panel-specific properties you just set.

**Defer all native window work to first-paint-ready.** The native handle is
valid immediately after construction, but the view's window may briefly be nil;
calling early races and silently degrades to a plain panel.

### 2.2 Platform-inverted rules — these bite

| | macOS | Windows |
|---|---|---|
| `setAlwaysOnTop` on blur | **never** — it triggers app activation and steals focus from the meeting | **always re-assert** — DWM-hooking share tools demote even topmost windows |
| Always-on-top level | `floating` | **`screen-saver`** — `floating` renders *behind* F11-fullscreen browser windows |
| `setOpacity(0)` before `hide()` | **forbidden** — WindowServer re-registers the app as a regular window | required, as part of the capture-flag dance |

### 2.3 Click-through

Pure Electron: `setIgnoreMouseEvents(true, { forward: true })`. Global, not
per-region — there is no practical hit-testing path.

**Never pair it with `setFocusable(false)`.** When the overlay is the only
visible window, macOS then treats the app as having no active windows and can
**stop delivering global hotkey events entirely**, silently breaking every
binding.

Because the toggle button itself becomes click-through, **a global hotkey must be
the escape hatch** — otherwise the user is locked out of their own overlay.

**Re-validate global shortcuts after any visibility, focusability, or
passthrough change, and on a ~10 s poll.** The OS silently drops hotkey
registrations when window state changes. Re-register individually rather than
unregister-all-then-re-register, so there is never a gap.

---

## 3. Typing without focus — macOS only

**Purpose: typing into Nova's own overlay.** The tap exists so the user can type
a question to their copilot without the meeting app losing focus mid-call. It
reads keystrokes only while the user is addressing Nova, forwards everything
else untouched, and nothing typed into other applications is stored or sent
anywhere. It is an input path for our own window, not a keystroke log.

A session-level `CGEventTap` is the **only** way to accept free-form typed text
while another app remains key. Electron's `globalShortcut` gives discrete
accelerators and nothing more; any DOM-focus path forces the panel to become key
window, which the meeting app can observe.

**Windows has no equivalent.** The overlay must take real focus to accept text.
Plan the documented capability split (design doc §4.3) rather than shipping a
Windows path that pretends otherwise.

If we build the tap:

- **Permission is Accessibility** (`AXIsProcessTrusted`), not Input Monitoring —
  pure TCC, no entitlement, no usage string. **The app must be restarted after
  the user grants it**; macOS does not retroactively grant tap rights to a
  running process.
- **The OS will disable your tap.** `kCGEventTapDisabledByTimeout` fires if any
  callback exceeded ~1 s. You must re-enable it in place from inside the
  callback, or every subsequent keystroke silently goes to the foreground app.
- **Never swallow everything.** Pass through anything carrying Cmd/Opt/Ctrl/Fn,
  all F-keys (F1–F20), Tab, arrows, and all modifier-change events. A blanket
  swallow breaks Cmd+Tab, Cmd+Q, Spotlight, volume, brightness and media keys
  system-wide.
- **Composition IMEs are fundamentally broken under a tap** — it sits below the
  Text Input System, so Pinyin/Hangul/Kanji users get literal Latin characters.
  Detect an active IME and refuse to auto-engage.
- **Run it on a dedicated thread** (the run loop blocks) and **join that thread
  inside stop** before allowing a restart, or a fast stop→start produces a
  permanently un-stoppable tap.
- Clamp the reported unicode length to your buffer — the API reports the full
  composition length even after truncating, and an unclamped read walks off the
  stack.

---

## 4. Content protection and the watchdog — chunks 4 and 6

**This is the product-defining feature, and Windows is where it ships first.**
The Windows mechanism is real and documented; the macOS public API is dead and
its private surface is under research (design doc §4.1). Everything below is the
Windows path unless marked otherwise.

- **Set the flag *after* the window is shown and composited, not before.** The
  ordering that works is show-at-opacity-0 → set flag → wait ~60 ms → opacity 1.
  A flag applied to a not-yet-composited window is silently ignored — this is
  the single most common reason a "working" implementation isn't hidden.
- **Windows 11 caveat to settle in chunk 1:** there are reports that the affinity
  call fails specifically for Chromium/Electron-class windows on Windows 11
  (returning an error while succeeding for classic Win32 apps), acknowledged by
  a Microsoft engineer around 2022 with no published fix. Nobody has verified it
  against current builds. Probe it on real hardware before designing around it;
  if it reproduces, the window layer moves into the native addon rather than
  relying on Electron's wrapper.
- **macOS is the opposite** — set before showing.
- **Dedupe redundant writes.** Repeated identical sets cause compositor churn
  that can leave the window in a transient blank frame for hundreds of ms.
- **Every window needs it independently.** There is no framework hook that
  guarantees coverage. Centralise on one interface (`set`, `reassert`, stored
  intent) and have window creation read the stored intent, so windows created
  *after* a toggle are born protected.
- **macOS: any activation-policy flip (dock show/hide) can silently reset the
  flag.** Re-assert unconditionally afterwards, bypassing whatever
  "value unchanged" guard you built — the stored value is still right while the
  OS value is wrong.
- **Never let a failure fall through into showing the window.** Consolidate
  attribute application and reveal into one path so a swallowed error cannot
  expose an unprotected window.

### macOS — the call that actually works (chunk 8)

Do **not** use `NSWindow.sharingType` / Electron's `setContentProtection`. Apple
retired it, and it is why Electron windows in this category still appear in a
modern screen share.

The mechanism is a private CoreGraphics/WindowServer SPI:

```
CGSConnectionID CGSMainConnectionID(void);
CGError CGSSetWindowCaptureExcludeShape(CGSConnectionID cid,
                                        CGSWindowID wid,
                                        CGRegionRef region);
CGRegionRef CGRegionCreateWithRect(CGRect rect);
```

Pass a region built from the window's frame (origin zeroed) to exclude; pass
`NULL` to re-enable. `wid` is the window's `windowNumber`. It operates per
window and per region — strictly more expressive than the old boolean.

**Why to trust it:** Chromium calls exactly this at HEAD, in
`components/remote_cocoa/app_shim/native_widget_ns_window_bridge.mm`
(`NativeWidgetNSWindowBridge::SetAllowScreenshots`), having removed `sharingType`
from its Mac window code entirely. Chrome's content protection depends on it on
every Mac today. The symbol dates to at least macOS 10.13 and Apple's own apps
call it.

**Why Electron apps do not have it:** Electron picked up Chromium's replacement
and reverted it (electron#46886) over a *rendering* bug — transparent child
windows drawing grey — not a hiding failure. Chromium's version made the call
async, which is the likely culprit; a synchronous direct call may not reproduce
it. **If Nova's overlay is transparent with child windows, budget for this.**

**Unproven, and must be probed first.** No published test exists against
ScreenCaptureKit on macOS 15+. Chunk 8 opens with a standalone ~30-minute probe:
a borderless always-on-top window, the SPI called with a full-frame region, then
capture via Cmd-Shift-5, QuickTime, a minimal `SCStream` on
`SCContentFilter(display:excludingApplications:exceptingWindows:)`, and a real
Zoom full-display share to a second device. Verify the `NULL`-region round trip
re-enables capture.

**Secondary lead if it fails:** `kCGSAvoidsCaptureTagBit` (bit 6 of the *hi*
word) in the WindowServer per-window tag bitmap, set via `CGSSetWindowTags` —
the same bitmap the `_setPreventsActivation:` trick uses (bit 16, lo word). It
is the only capture-related tag in the reverse-engineered enumeration, and
nobody has published a working use of it. Try it only if the exclude-shape call
does not hold up.

**Private API risk posture.** Nova ships outside the App Store, so this is a
stability question, not a distribution blocker — and the profile is unusually
good: decade-old symbol, Apple's own apps use it, Chrome breaks first if it ever
goes away.

**A detect-and-hide fallback exists but is not a primary mechanism.**
`CGSIsScreenWatcherPresent()` and the `isCaptured` change notification let an app
react to a capture starting — but the notification is reactive (the first frames
are already captured), and it is reported not to fire for Microsoft Teams at all.
Useful as a second layer, never as the feature.

### The watchdog — our improvement, not a copy

The reference implementation has **no read-back and no watchdog at all**. It
never reads the flag back, never polls, and its UI reports stored *intent* as if
it were verified state — so it can cheerfully display "hidden" while the OS has
switched it off.

Both platforms **do** expose a read-back (`GetWindowDisplayAffinity` on Windows,
the window's sharing type on macOS). Chunk 6 should:

1. Poll the real OS value rather than trusting our own stored boolean.
2. Re-assert on the events the reference never hooks: display add/remove/metrics
   change, session lock/unlock, fullscreen transitions, window reparenting, and
   remote-desktop session change.
3. Expose a **third UI state** — *hidden* / *visible* / *cannot verify* —
   distinct from the on/off toggle.

---

## 5. Screenshots — later chunk, not on the critical path

Pure Electron (`desktopCapturer`). No native code. On macOS it rides the same
Screen Recording grant that system audio already needs.

- **Hide your own windows and wait ~80 ms (macOS) / ~40 ms (Windows) before every
  capture.** Content-protection flags do not reliably exclude you from your own
  capture, and a shorter wait produces black frames.
- **Route every capture through one single-flight session object** that
  snapshots visibility, hides, waits, captures, and restores in a `finally`.
  Ad-hoc hide/show around each call site is the bug pattern.
- **Request thumbnails at logical, not physical, resolution.** Electron already
  returns native pixel density; multiplying by scale factor costs 50–200 ms of
  blocking main-thread decode for zero quality gain.
- Multi-monitor crops need **per-display thumbnail÷bounds ratios**; single-display
  crops use the plain scale factor. Mixing them is the classic DPI bug.
- **Clamp and byte-cap before sending to a vision model** — long edge
  1024–1920 px, JPEG q78–q90, ~3.5 MB ceiling with a quality step-down retry, and
  fail *open* to the original if encoding errors.
- **Own retention explicitly.** A FIFO cap plus a quit-time purge that operates on
  the live queue. (The reference app's quit-time cleanup constructs a fresh empty
  helper and deletes nothing, while logging that it succeeded.)
- Nova adds what the reference lacks: **no redaction or PII step exists there at
  all.** Decide ours deliberately before shipping this.

---

## 6. Packaging, signing, shipping — chunk 7

- **`asarUnpack` for `**/*.node` and `**/*.dylib` is non-negotiable** — native
  binaries cannot be loaded from inside an asar archive. Then make every runtime
  path resolver aware of the unpacked directory, and load native binaries by
  absolute path from the resources path *first* in packaged builds. Otherwise
  Electron's filesystem interceptor hands back the JavaScript stub instead of the
  binary.
- **Add a post-load functional smoke call**, not just a symbol-presence check —
  the stub case exports every correct name and cannot load anything.
- **Node-API means no Electron rebuild for our own addon.** Keep it that way by
  refusing raw-V8 dependencies.
- **macOS entitlements: only what we use.** JIT, unsigned executable memory, and
  disable-library-validation (needed the moment we ship any third-party native
  lib), plus audio-input. **Screen capture and Accessibility are pure TCC, not
  entitlements** — adding a speculative `screen-capture` entitlement is
  meaningless because no such entitlement exists.
- **Notarization staple flakes.** The submit call returns when Apple has decided,
  but the ticket reaches their CDN slightly later, so an immediate staple fails
  with "Record not found" / Error 65 on a build that actually succeeded. Wrap the
  staple in exponential backoff matching *only* those errors, so genuine
  rejections still fail the build.
- **electron-builder's DMG step can corrupt the embedded signature**, and the
  failure only surfaces in Apple's notary log. Shipping ZIP-only on macOS avoids
  the entire problem; the auto-updater consumes the ZIP anyway.
- **Gate in-place auto-update on actually being signed.** Squirrel.Mac will not
  swap an unsigned app, so unsigned macOS must fall back to a manual download.
  Carry a build-time flag into the packaged manifest and **have CI assert it is
  present**, or a signed build that forgets it silently degrades to manual
  updates.
- **Keep large assets out of the installer.** The reference app ships ~305 MB of
  resources including both full and quantized copies of two ML models and a
  70 MB demo GIF, in every installer on every platform.
