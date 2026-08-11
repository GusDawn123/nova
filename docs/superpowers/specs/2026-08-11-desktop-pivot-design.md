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
| **Ratified** | desktop pivot; Electron + C++ Node-API addon; audio-first build order; wire format; two-stream speaker attribution |
| **Open — needs Gustavo** | stealth posture (A/B below); `apps/mobile` fate; bundle id; macOS minimum version |
| **Not started** | every chunk. No code has been written. |

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
│  │  system audio:  macOS CoreAudio tap  (14.4+)          │  │
│  │                 macOS ScreenCaptureKit (13+, fallback)│  │
│  │                 Windows WASAPI loopback               │  │
│  │  microphone:    one cross-platform capture path       │  │
│  │  → normalises everything to ONE PCM format            │  │
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

**The addon does audio and nothing else — at first.** Everything in chunks 1, 3,
4 and 5 is achievable in pure Electron. Native code is expensive to build, sign,
and debug; we add it only where the platform gives us no choice.

---

## 4. Platform reality — read this before promising anything

Three findings from the research materially constrain the product. They are
facts about macOS and Windows, not opinions about our design.

### 4.1 macOS cannot hide a window from screen capture. At all.

Apple's own documentation for `NSWindow.SharingType.none` — the flag every
overlay app uses, and what Electron's `setContentProtection(true)` sets — now
describes it as a legacy constant macOS no longer uses, and instructs developers
not to use it to hide content from capture. In July 2025 an Apple DTS engineer
answered this exact question on the developer forums: there are **no public APIs
for preventing screen capture**, and asked the developer to file an enhancement
request.

> **Consequence:** on macOS, if the user shares their whole screen, the Nova
> overlay is visible to everyone on the call. There is no workaround. Any
> marketing claim of invisibility on macOS would be false.

The one thing that still works is structural and not ours to control: if the
user shares a **single window** rather than the full display, our overlay was
never in the capture to begin with.

### 4.2 Windows can, but Microsoft disclaims it — and Electron may be excluded.

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

| # | Chunk | Native? | Deliverable | How we prove it |
|---|---|---|---|---|
| 0 | **This design doc** | no | the pivot written down; CLAUDE.md and doc amendments | Gustavo reviews and ratifies |
| 1 | **Electron shell** | no | a normal visible window that boots, loads the UI, signs in through the existing Supabase seam, and calls `GET /me` | app shows the signed-in user's data, pulled from the real server. Plus: the §4.2 Windows 11 probe, result recorded |
| 2 | **System audio capture** | **yes** | two labelled PCM streams (loopback + mic) arriving in the Electron main process in the §5.2 wire format | a recorded two-party call produces two `.wav` files, each containing only its own speaker |
| 3 | **Live transcription end-to-end** | no | both streams over the existing `/live` socket; transcript renders with correct `me`/`them` labels | a real call transcribes live, speakers correctly attributed, notes generated post-call |
| 4 | **Overlay window** | partly | frameless, always-on-top, floats over fullscreen Zoom, never steals focus | clicking the overlay during a Zoom call does not dim or un-focus Zoom, on both OSes |
| 5 | **Hotkeys + click-through** | no | summon, dismiss, and steer without ever clicking into the overlay | full copilot loop driven from the keyboard while the meeting app stays frontmost |
| 6 | **Content protection + honest status** | no | best-effort hide-from-capture where the OS supports it, plus a UI state that distinguishes *hidden* / *visible* / *cannot verify* | flag read back from the OS, not from our own stored intent — the thing the reference implementation never did |
| 7 | **Packaging and shipping** | no | signed, notarized, auto-updating installers for macOS and Windows | a fresh machine installs from the artifact and auto-updates to the next build |

**Chunk 2 is the existential one.** If system audio capture cannot be made to
work reliably, there is no product, and we want to know that in week one rather
than after building an overlay around it. Everything before it exists only to
give chunk 2 somewhere to land.

**Screenshots are deliberately absent.** The reference app captures the screen
on demand and sends it to a vision model. It is entirely pure-Electron
(`desktopCapturer`), needs no native code, and rides the Screen Recording grant
we already have on macOS. It is a real feature we can add later as its own
chunk — it is not on the critical path to a working call copilot.

---

## 7. Costs this pivot introduces

Expo/EAS handled packaging, signing, and updates. None of that exists for
Electron until we build it (chunk 7).

| Item | Cost | Required? |
|---|---|---|
| Apple Developer Program | **$99/yr** | **Yes** for macOS. Without it users see "app is damaged" and auto-update cannot install |
| Windows code-signing (Azure Trusted Signing) | ~$120/yr (estimate) | No — but unsigned means every user meets the SmartScreen warning |
| CI that builds native binaries per platform | GitHub Actions minutes | Yes — macOS arm64, macOS x64, Windows x64 |

Enrolling in the Apple program as an individual is fine (CLAUDE.md: no entity
yet, store accounts individual). Note the app will list Gustavo's own name as
the developer.

---

## 8. Open decisions — Gustavo

**8.1 — Stealth posture.** Given §4.1:

- **A (recommended): demote.** Stealth becomes a best-effort Windows feature with
  an honest UI state, sequenced late (chunk 6). macOS simply does not get
  invisibility and we say so plainly. Never claim "invisible" in marketing.
- **B: keep as a pillar.** Build it Windows-first anyway and accept that macOS
  users get a visible overlay while we wait for Apple to reverse a documented
  position.

Recommendation is **A**. B spends the scariest chunks on something Apple has
publicly closed, and puts a promise in the marketing we would have to retract.
The chunk list above is written assuming A; under B, chunk 6 moves to position 3.

**8.2 — `apps/mobile`.** Delete outright, or freeze in place with a tombstone
banner? Deleting is cleaner and git keeps the history; freezing keeps the
duotone component library visible while the desktop renderer is built. Mild
preference for **freeze now, delete after chunk 4**, once we know what the
renderer actually reuses.

**8.3 — Bundle id.** Must be chosen **before the first signed build** and can
never change afterwards: macOS ties every permission grant to it, so changing it
resets every user's microphone, screen-recording and accessibility approvals.
Suggested `com.novaapp.nova`. Gustavo's call.

**8.4 — macOS minimum version.** 14.4 gives the clean CoreAudio tap with no
screen-recording prompt. 13.0 reaches more users but forces the
ScreenCaptureKit path and its scary permission dialog for *every* user. Leaning
**support both, prefer 14.4 at runtime** — but that is a chunk-2 decision and can
wait.

---

## 9. Documents this pivot amends

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
