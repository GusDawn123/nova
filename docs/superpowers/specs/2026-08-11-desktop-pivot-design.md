# Nova desktop pivot — design

Written 2026-08-11 with Gustavo, on `dev-nova-desktop-pivot` (branched off
`development`). This is the **scoping** document for the pivot: the shape, the
constraints, and the ordered chunk list. It is deliberately **not** an
implementation plan. Each chunk below gets its own branch, its own plan, its own
CodeRabbit pass, and its own PR.

Companion: [`docs/DESIGN/desktop-native-notes.md`](../../DESIGN/desktop-native-notes.md)
— the field notes gathered while studying a reference implementation.

---

## Status

| | |
|---|---|
| **Ratified** | desktop pivot; Electron + C++ Node-API addon; audio-first build order; wire format; two-stream speaker attribution; **stealth is a core product feature, not a nice-to-have**; **Windows ships first, macOS is scaffolded but not built** |
| **Open — needs Gustavo** | `apps/mobile` fate; bundle id; macOS minimum version |
| **Not started** | every chunk. No code has been written. |

**Ratified 2026-08-11 (Gustavo, explicit):** stealth is the reason this product
exists — a sales copilot that is visible in a screen share is not the product.
No architecture is dropped. We build Windows first, where the mechanism is
documented and real, and we lay the macOS folder structure and port boundaries
in place so the macOS implementation drops in later without a refactor.

---

## 1. Why we are pivoting

Nova's premise is that it hears both sides of a call. On mobile that was only
ever achievable **acoustically** — speakerphone, both voices through the air into
one mic, split downstream by vendor diarization
([`docs/DESIGN/audio-capture.md`](../../DESIGN/audio-capture.md)). That model has
three unfixable problems:

1. **iOS blocks microphone access during a cellular call.** Not a limitation —
   there is no API. Same-phone capture is a hard no.
2. **Bluetooth headphones destroy it.** A room mic cannot hear inside an ear.
   This is what `dev-nova-audio-routing` was written to work around.
3. **Acoustic capture is lossy by construction.** Speaker bleed, room noise,
   and diarization guesswork all sit between the caller and the transcript.

Desktop removes all three at once, because the OS lets us tap the audio stream
**before it reaches the speaker**:

```
            ┌─ system audio loopback ──► "them"  (the far end, verbatim)
  the call ─┤
            └─ microphone ─────────────► "me"    (the user, verbatim)
```

Two clean streams. No air gap, no diarization guess, no headphone problem — in
fact headphones become *required* (see §4). Speaker attribution stops being a
model output and becomes a fact about which socket the bytes arrived on.

---

## 2. What survives, what changes, what dies

**Survives untouched.** This is the whole point — the pivot replaces one client,
not the product.

- `apps/server` — Fastify, the authed `/live` socket, `modules/stt`,
  `modules/llm`, `modules/rag`, `modules/notes`, `modules/prompt`,
  `modules/metering`, `modules/live`, roles, quotas, the kill switch. All of it.
- `packages/shared` — the zod wire types. The desktop client speaks the **same**
  protocol (`v: 1`), so `session.start`, `transcript.input`, and the suggestion
  stream events need no change.
- `supabase/` — schema, RLS, migrations, pgvector.

**Changes.**

- **Two audio streams instead of one.** The client opens system-audio and mic as
  separately labelled sources. `speaker` is set by the source, not inferred.
- **Diarization becomes optional.** Needed only when more than one person is on
  the far end (they all arrive on the single loopback stream). The 2-person case
  — the overwhelming majority — needs none.
- **Billing shape.** Two streams means two STT sessions. Per Gustavo's
  2026-08-11 instruction, unit economics are explicitly **out of scope** for this
  pivot; `docs/BUSINESS/unit-economics.md` is stale until revisited.

**Dies.**

- `apps/mobile` — the entire React Native / Expo client, plus EAS build config.
  **Open decision:** delete, or freeze with a tombstone banner? (§8)
- `docs/DESIGN/audio-capture.md` — the acoustic pre-spec. Superseded; should be
  banner-tombstoned the way `live-notes.md` was.
- `dev-nova-audio-routing` (2 unmerged commits) — the Bluetooth degradation
  spec. Its *problem* is gone; its *research* about route detection still
  applies to picking the right output device. Rewrite, don't delete.

---

## 3. The shape

```
┌─ Electron main process ── TypeScript ───────────────────────┐
│                                                             │
│  window + overlay management ............ pure Electron     │
│  global hotkeys ......................... pure Electron     │
│  Supabase auth (existing seam) .......... reused            │
│  /live socket client .................... packages/shared   │
│                                                             │
│  ┌─ native addon ── C++ / Node-API ──────────────────────┐  │
│  │  AudioCapture port                                    │  │
│  │    Windows: WASAPI loopback + mic        ◄── FIRST    │  │
│  │    macOS:   CoreAudio tap (14.4+) / SCK (13+)         │  │
│  │    → normalises everything to ONE PCM format          │  │
│  │                                                       │  │
│  │  StealthWindow port                                   │  │
│  │    Windows: display affinity + read-back ◄── FIRST    │  │
│  │    macOS:   AppKit — NSPanel attributes Electron      │  │
│  │             does not expose, and the WindowServer     │  │
│  │             tag surface beneath it                    │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
┌─ Renderer ── React ─────────┴───────────────────────────────┐
│  the copilot surface. Reuses the duotone design language    │
│  from docs/superpowers/specs/2026-08-02-nova-ui-design.md   │
└─────────────────────────────────────────────────────────────┘
```

**Module discipline carries over from `docs/RULES.md`.** The addon is a vendor
adapter by another name: OS APIs live behind one `AudioCapture` port, the same
way vendor SDKs live only under `modules/*/adapters/`. Nothing above the addon
boundary knows whether it is talking to CoreAudio or WASAPI.

**Two ports, both platform-split, both scaffolded for macOS from day one.** The
macOS branch of each port exists as a stub with the real signature from the
first commit, so adding the macOS implementation later is filling in a file
rather than reshaping the boundary. That is the whole reason to define the port
now rather than after Windows ships.

**Where Electron is enough, use Electron; where it is not, go native.** On
Windows the capture-exclusion mechanism is reachable through Electron's own API,
so the Windows branch of `StealthWindow` is thin — it exists for the read-back
and re-assert that Electron does not expose (§10). On macOS it will not be thin:
the attributes that matter live in AppKit and below it, and Electron exposes
none of them. That asymmetry is expected and is not a reason to avoid native
code on either side.

---

## 4. Platform reality — read this before promising anything

Three findings from the research materially constrain the product. They are
facts about macOS and Windows, not opinions about our design.

### 4.1 macOS: the public API is dead, but the mechanism exists — and Chrome uses it

The public flag (`NSWindow.sharingType`, which Electron's
`setContentProtection(true)` sets) is finished: Apple's own documentation calls
it a legacy constant and tells developers not to use it to hide content, and
Apple DTS confirmed in July 2025 that no **public** API exists.

**That is not the whole story.** The working mechanism is a private
CoreGraphics/WindowServer call:

```
CGSSetWindowCaptureExcludeShape(CGSMainConnectionID(), windowNumber, region)
```

Pass a region and the WindowServer excludes that region of that window from
capture; pass `NULL` to re-enable. It is **region-shaped**, which is strictly
more expressive than the old boolean flag — an implementation can exclude only
the answer panel and leave other chrome visible.

Three facts make this credible rather than a forum rumour:

1. **Chromium ships it at HEAD, today**, in
   `native_widget_ns_window_bridge.mm`, as its *only* macOS content-protection
   mechanism. Chromium **deleted `sharingType`** from its Mac window code
   entirely.
2. **Google Chrome's content protection on every Mac depends on it right now.**
   If Apple breaks it, Chrome breaks first and loudly — a free canary and a
   strong reason Apple would provide a migration.
3. The symbol has existed since at least macOS 10.13 and Apple's own apps call
   it.

**Why every competitor is still visible.** Electron briefly picked up Chromium's
new implementation and **reverted it** (electron#46886) — for a *rendering*
regression (transparent child windows drawing grey), **not** a hiding failure.
So Chrome protects windows with the working call while every Electron app,
including Cluely and its clones, still uses the dead flag. That single fact
explains the entire category's macOS problem, and it is fixable in a small
native addon.

**Status: STRONG, not yet proven.** Nobody has published a test of this call
against ScreenCaptureKit on macOS 15+. The inference is sound — Chromium
switched to it in the same window Apple made the flag inert, and it operates at
the WindowServer layer that *produces* SCK frames rather than the AppKit layer
Apple deprecated — but it is inference. **Chunk 8 opens with a ~30-minute
standalone probe** (borderless window, call the SPI, then capture with
Cmd-Shift-5, QuickTime, a minimal `SCStream`, and a real Zoom full-display
share) before any macOS work is planned around it.

**Two things we will not do.** We will not build on ScreenCaptureKit happening
to honour the old flag — that behaviour is a bug in both directions (Apple's own
sample omits such windows on a fresh filter and reveals them after a live filter
update; bug FB21115847), which is exactly why competitors' users sometimes get
caught. And we will not put an unqualified invisibility claim in marketing for
an OS until it has been verified there against a real screen share.

**Also worth recording, because it is everywhere and it is false:** several
sites claim these tools render "on a GPU hardware overlay plane below what
screen sharing captures." There is no app-accessible hardware overlay plane on
macOS; Metal layers are composited by the WindowServer like everything else.
That story is fabricated SEO content and must not enter any Nova design.

### 4.2 Windows: real, documented — and the first target

`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` is real, documented, and
works on Windows 10 2004+. Microsoft's own docs state it is not a security
feature and offer no guarantee. Worse, there are reports that on Windows 11 the
call **fails for Chromium/Electron-class windows** while succeeding for classic
Win32 apps, acknowledged by a Microsoft engineer.

> **Action:** chunk 1 includes a five-minute probe on Gustavo's actual Windows 11
> machine — call it, check the return value, screen-share to a second device.
> We settle this before designing anything on top of it.

### 4.3 Typing into the overlay works differently on each OS.

| | macOS | Windows |
|---|---|---|
| Overlay can float over another app's fullscreen | ✅ `FullScreenAuxiliary` + `visibleOnFullScreen` | ⚠️ only via the `screen-saver` window level |
| Click a button without activating our app | ✅ NSPanel + `becomesKeyOnlyIfNeeded` | ❌ no equivalent |
| **Type free-form text without taking focus** | ✅ only via a session `CGEventTap` — needs **Accessibility** permission and an app restart after granting | ❌ **not possible.** The overlay must take real focus; the meeting app sees a focus change |

This is a **documented capability split**, not a gap to close. We should not ship
a Windows path that pretends to be stealthy.

### 4.4 Permissions the user must grant

| Platform | Grant | Needed for | Notes |
|---|---|---|---|
| macOS | Microphone | mic capture | standard prompt |
| macOS | **Screen Recording** | system audio **and** screenshots | one grant covers both. Only appears when a protected API is actually called |
| macOS | Accessibility | keyboard tap — **only if we build it** | requires an app restart after granting |
| Windows | — | — | no equivalent gating |

macOS onboarding therefore has to walk a user through two prompts minimum. That
is a design problem for a later chunk, but it belongs on the record now.

---

## 5. Ratified decisions

1. **Node-API (via `node-addon-api`) for the C++ addon.** It is ABI-stable
   across Node *and* Electron versions, which means our addon never needs
   rebuilding when Electron updates. Corollary: **prefer Node-API dependencies**
   — pulling in a raw-V8 native module (e.g. `better-sqlite3`) reintroduces the
   entire electron-rebuild problem we are avoiding.
2. **One wire PCM format, normalised in the addon:** 16 kHz · 16-bit signed ·
   mono · little-endian · 20 ms frames (320 samples / 640 bytes), delivered in
   batches of ~3 frames (~60 ms) to keep per-call FFI overhead down. This is
   what every STT vendor accepts and what `modules/stt` already expects.
3. **Two labelled streams; no diarization in the 2-person case.**
4. **Headphones are required for correctness in v1.** There is no acoustic echo
   cancellation. On open speakers the far end lands in *both* the loopback and
   the mic, and gets transcribed twice. AEC is a deliberate later decision, not
   an oversight — it must be stated in onboarding.
5. **Licensing.** The reference implementation studied for this design is
   **AGPL-3.0**. Nova is closed-source and commercial. Architecture, OS API
   choices, and documented gotchas are not copyrightable and are recorded in the
   companion notes; **no code from that project may be copied, translated, or
   adapted into this repo.** Implementers build from Apple, Microsoft, and
   Electron documentation.
6. **Branch/review discipline unchanged** (`docs/GIT_WORKFLOW.md`): one chunk →
   one `dev-nova-*` branch off `development` → `npm run check` green →
   `coderabbit review --agent --base development` → PR into `development` →
   Gustavo's go-ahead to merge. Never two chunks in flight.

---

## 6. The chunk list

Ordered to stand the shell up, then prove the one risk that can kill the product,
then make it usable, then ship it. Each row is a self-contained branch.

**Windows only.** Every chunk below targets Windows. The macOS branch of each
port is created as a signature-complete stub in the same chunk that creates the
Windows one, so nothing has to be reshaped later — but no macOS implementation
is written until the Windows product works end to end.

| # | Chunk | Native? | Deliverable | How we prove it |
|---|---|---|---|---|
| 0 | **This design doc** | no | the pivot written down; CLAUDE.md and doc amendments | Gustavo reviews and ratifies |
| 1 | **Electron shell** | no | a normal visible window that boots, loads the UI, signs in through the existing Supabase seam, and calls `GET /me` | app shows the signed-in user's data from the real server. **Plus the §4.2 probe:** call the affinity API from a real Electron window on this Windows 11 machine, record the return value, screen-share to a second device and look |
| 2 | **System audio capture** | **yes** | two labelled PCM streams — WASAPI loopback + mic — arriving in the main process in the §5.2 wire format, handling **both** the multimedia and communications default output roles | a recorded two-party Zoom call produces two `.wav` files, each containing only its own speaker, with the meeting routed to the communications device |
| 3 | **Live transcription end-to-end** | no | both streams over the existing `/live` socket; transcript renders with correct `me`/`them` labels | a real call transcribes live, speakers correctly attributed, notes generated post-call |
| 4 | **Stealth overlay window** | **yes** | frameless, always-on-top over fullscreen Zoom, capture-excluded, applied in the correct DWM order, never steals focus | **the product test:** join a Zoom call from this machine, share the full screen to a second device, and confirm the overlay is absent from what the second device sees while remaining visible locally |
| 5 | **Overlay interaction** | no | global hotkeys to summon, dismiss, and steer; click-through so clicks reach the app underneath | the full copilot loop driven from the keyboard with the meeting app frontmost the entire time |
| 6 | **Stealth watchdog + status** | **yes** | read the affinity flag back from the OS, re-assert on the reset events, and surface *hidden* / *visible* / **cannot verify** to the UI | force a reset (display change, session lock, fullscreen transition) and watch the app detect it and recover — the thing the reference implementation never built |
| 7 | **Packaging and shipping** | no | signed, auto-updating Windows installer | a fresh Windows machine installs from the artifact and auto-updates to the next build |
| 8+ | **macOS** | **yes** | fill in the macOS branch of each port | its own design pass, informed by the §4.1 research, before any of it is planned |

**Chunk 2 is the existential one.** If system audio capture cannot be made to
work reliably, there is no product. Chunks 0 and 1 exist only to give it
somewhere to land.

**Chunk 4 is the product-defining one.** A sales copilot that appears in a
screen share is not the product. Its proof criterion is deliberately the real
one — an actual Zoom share observed from a second device — not a unit test.

**Screenshots are deliberately absent.** The reference app captures the screen
on demand and sends it to a vision model. It is entirely pure-Electron
(`desktopCapturer`), needs no native code, and rides the Screen Recording grant
we already have on macOS. It is a real feature we can add later as its own
chunk — it is not on the critical path to a working call copilot.

---

## 7. Costs this pivot introduces

Expo/EAS handled packaging, signing, and updates. None of that exists for
Electron until we build it (chunk 7).

| Item | Cost | When |
|---|---|---|
| Windows code-signing (Azure Trusted Signing) | ~$120/yr (estimate) | **Chunk 7.** Unsigned ships and works, but every user meets the "Windows protected your PC" warning, which costs installs |
| CI that builds the native addon | GitHub Actions minutes (Windows runners bill at 1×) | Chunk 2 onward — Windows x64 only, at first |
| Apple Developer Program | $99/yr | **Deferred to chunk 8+.** Not needed until macOS is built |

Both signing options enroll fine as an individual (CLAUDE.md: no entity yet,
store accounts individual), with the caveat that the certificate will carry
Gustavo's own name rather than a company's. Azure Trusted Signing additionally
requires an organisation 3+ years old, so if that gate applies, a standard OV
certificate (~$200–400/yr, estimate) is the fallback.

---

## 8. Open decisions — Gustavo

**8.1 — `apps/mobile`.** Delete outright, or freeze in place with a tombstone
banner? Deleting is cleaner and git keeps the history; freezing keeps the
duotone component library visible while the desktop renderer is built. Mild
preference for **freeze now, delete after chunk 4**, once we know what the
renderer actually reuses.

**8.2 — Bundle id / app id. RATIFIED 2026-08-12: `com.novacopilot.nova`.**

Chosen before the first signed build, deliberately. On macOS it can never change
afterwards — every permission grant is keyed to it, so changing it later resets
every user's microphone, screen-recording and accessibility approvals at once.
The reference implementation is stuck shipping v2.7 under a leftover
`com.electron.meeting-notes` for exactly this reason.

Windows ships first, but both platforms use the same id so nothing has to be
reconciled later. It lands in the packaging config in chunk 7; nothing before
that reads it.

**8.3 — macOS minimum version.** Deferred to the macOS design pass (chunk 8+).
Not needed for anything on the Windows path.

---

## 9. Where we deliberately differ from the reference — and why

The default is **mirror it**. The reference implementation's shape is the proven
shape for this category, and its comments are a ledger of production bugs
someone already paid for. Deviating without a reason costs performance and
quality and buys nothing.

So every deviation is listed here with its justification. If a change is not on
this list, it is not sanctioned — build it the way that is known to work.

| We differ | Why it is *better*, not just different |
|---|---|
| **Handle both Windows output device roles** (multimedia *and* communications) | Not a preference — the reference binds only the multimedia default, and its own comments record that this captures **silence** when the meeting routes to the communications device, which is what Zoom, Teams and Discord commonly do. It is an open bug there. Fixing it is table stakes. |
| **Read the affinity flag back from the OS and re-assert on reset events** | The reference has no read-back and no watchdog. Its UI reports stored *intent*, so it can display "hidden" while the OS has silently switched the flag off — the user finds out when a prospect mentions it. Both platforms expose a read-back; using it is strictly more correct. |
| **A third UI state: *cannot verify*** | Follows directly from the read-back. A binary on/off toggle cannot express "we asked, and we could not confirm", which is the state that actually matters to someone about to share their screen. |
| **Count and surface ring-buffer overruns** | The reference discards every push result, so audio drops are invisible and surface later as an unexplained transcription gap. A counter costs nothing. |
| **Keep the audio callback genuinely lock-free** | The reference's callback locks a mutex to signal a condition variable that nothing waits on. Removing it is strictly less work at strictly lower risk. |
| **C++ over Node-API instead of Rust** | Gustavo's call, ratified. Node-API is the same ABI-stable boundary the reference uses (napi-rs is Node-API), so this is a language change, not an architecture change. |
| **Reuse Nova's existing server** | The reference is a self-contained desktop app. Nova already has an authed `/live` socket, STT failover, RAG memory, metering, quotas and notes in production. The desktop client is a client. |
| **macOS: `CGSSetWindowCaptureExcludeShape`, not `sharingType`** (chunk 8) | The single most valuable finding in this research. The reference — and Cluely, and every clone in the category — hides windows with a flag Apple retired, which is why their users get caught. Chromium replaced that flag with this SPI and Chrome depends on it today. Using the call that actually works is not deviation, it is the difference between the feature existing and not. |

**Everything else mirrors the reference**, including the parts that look odd: the
Windows opacity-shield ordering before setting the capture flag, the DWM settle
delay, deduping redundant flag writes, NSPanel-before-attributes on macOS,
destroy-and-recreate rather than stop-and-start for captures, the ~12 s
silent-capture watchdogs, and the asymmetric VAD configuration. Those are not
stylistic choices. Each one is a bug someone else already found.

---

## 10. Documents this pivot amends

To be updated in the PR that lands this doc:

- **`CLAUDE.md`** — "What this is" is wrong from the first line (mobile AI call
  copilot → desktop). Stack section, mobile commands, and the Phase 9 mic-capture
  references all need rewriting.
- **`docs/ARCHITECTURE.md`** — module map gains the desktop client; the mobile
  client leaves.
- **`docs/DESIGN/audio-capture.md`** — banner-tombstone as superseded.
- **`docs/DESIGN/staging-and-distribution.md`** — EAS APK sideload is no longer
  the staging story; replace with Electron artifacts.
- **`docs/LOOP_PLAYBOOK.md`** — phases 8/9 were written around mobile.
- **`docs/BUSINESS/unit-economics.md`** — mark stale (two streams, desktop
  session lengths). Explicitly deferred by Gustavo, not silently ignored.
- **A new ADR** recording the pivot itself and the §4.1 macOS stealth finding,
  so nobody re-litigates it in six months.
