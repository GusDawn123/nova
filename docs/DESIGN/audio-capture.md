# Audio capture — Phase 9 pre-spec

Written 2026-08-03 from the architecture discussion with Gustavo. This is the
design knowledge for the mic-capture phase; the phase itself still gets a full
spec + plan before implementation.

## The capture model: acoustic, both voices, one mic

Nova never taps the phone call's audio stream — **no third-party app can**: both
OSes forbid call-audio access at the API level (wiretap territory; there is no
API to call). Instead, the call runs on **speakerphone**, so the other person's
voice comes out of the speaker, through the air, and into the microphone —
alongside the user's own voice.

```
Caller's voice ─► speaker ─► AIR ─► mic ─┐
                                         ├─► ONE PCM stream ─► /live socket ─► STT ─► diarization ─► "them"/"me"
User's voice ─────────────────► AIR ─► mic ┘
```

One mic, one stream, two voices — split downstream by the STT vendors'
diarization, which is already built and accuracy-gated with two-speaker fixtures
(Phase 3). The transcript's me/them roles were designed for exactly this.

**Supported launch scenario:** the call happens on ANY device with a speaker
(laptop Zoom, second phone, desk phone) and the Nova phone sits nearby
listening. **Same-phone capture:** iOS blocks app mic access during cellular
calls — hard no; Android is OEM-dependent on speakerphone — test-and-see on real
hardware, never promised.

## Audio routing: the headphones problem (added 2026-08-04)

The capture model has one load-bearing assumption: **the caller's voice exists in
the air**. Headphones — wired, Bluetooth, earbuds — break exactly that link: the
far voice moves from the loudspeaker into the user's ear and never reaches any
microphone, phone or BT. The side that vanishes is "them", the side the copilot
exists to answer. No mic choice fixes this; it is a routing problem, not a
sensitivity problem.

And capturing the call's audio stream instead remains a hard no (see above — no
API exists on either OS; Android's accessibility-service workaround is
store-rejection roulette and is off the table).

**Ratified strategy (Gustavo, 2026-08-04) — two tiers now, one held:**

1. **Route detection + guided degradation (MVP).** The `AudioCapture` port
   watches the audio route (`AVAudioSession` route / `AudioDeviceInfo`) at
   session start AND on route-change mid-call — AirPods connecting mid-call must
   trigger the same handling. On a headphone/BT route the cockpit says it in
   words, guide-style: *"I can only hear your side on headphones — swap to
   speaker for the full copilot."* Declining is a supported degraded mode, not an
   error: the user's side still transcribes, and the already-shipped typed-input
   path (`transcript.input`) carries "them". Route changes are typed events on
   the port, same discipline as mic interruptions.
2. **Capture policy under Bluetooth (Phase 9 test matrix).** Even on
   speakerphone, an active BT route threatens capture two ways: OS
   voice-processing is trained to delete exactly the speaker-leak we depend on
   (the `.measurement` / `VOICE_RECOGNITION` configs above exist for this), and a
   BT SCO mic is narrowband — poison for STT accuracy. Policy: **prefer the
   phone's own mic array for capture even when BT carries the call**, and the
   Phase 3 accuracy gates re-run per-route (speaker / speaker+BT-call / wired)
   on real hardware.
3. **HELD — server-side bridge (post-MVP).** Nova joining the call as an audio
   leg (conference bridge / VoIP dialer) is the real fix — routing-immune, works
   with any headset — but it adds per-minute telephony cost (a new constant for
   `docs/BUSINESS/unit-economics.md`) and collides with the "no bots joining
   calls" positioning. Product decision, not a technical one; revisit when real
   usage shows headphone-blocked sessions.

## Platform mechanics (the two implementations)

There are exactly two OSes; every phone brand is one of them. Both
implementations ship in the one app binary, behind a single `AudioCapture` port
(module-seam discipline, same as the server). The runtime activates its own path.

| | Android | iOS |
|---|---|---|
| OS API | `AudioRecord` | `AVAudioEngine` |
| Model | **pull** — your background thread loops `read()`, the OS fills your buffer | **push** — you install a tap on the input node, the OS calls you with buffers |
| Source config | `VOICE_RECOGNITION` source (disables OEM call-oriented processing) | `AVAudioSession` record category, `.measurement` mode (minimal processing) |
| Native format | PCM 16-bit at requested rate | 48 kHz Float32 → `AVAudioConverter` |
| Screen-off | Foreground Service, `foregroundServiceType="microphone"` (persistent notification; Play Console declaration) | `UIBackgroundModes: audio` entitlement |

Both normalize to the wire format the relay already carries: **16 kHz · 16-bit ·
mono PCM, ~100 ms chunks (3,200 bytes each)**, sent as binary frames on the
authed `/live` socket. The server needs ZERO changes — the relay is built,
metered by relayed bytes, and failover-proven; it never learns which OS the
bytes came from.

## Library decision (settled by an on-device spike, not on paper)

1. **`@siteed/expo-audio-studio`** — first choice: real-time PCM streaming,
   background recording, Expo config plugin, both platforms.
2. **`react-native-live-audio-stream`** — fallback: minimal, battle-tested,
   emits live PCM events; older, no background help.
3. **Own Expo native module** — escape hatch (~200 lines/platform doing exactly
   the table above).

Whichever wins is wrapped behind `AudioCapture`, so swapping is invisible. The
spike = real mic → staging server → transcript back, on Gustavo's Android first.

## Robustness requirements (any implementation)

- **Bounded ring buffer** between capture and socket — network jitter must never
  balloon memory; drop-oldest and mark the gap honestly.
- **Capture survives socket reconnects** — the mic keeps running; the reconnect
  machinery (server-side, already built) resumes the stream.
- **Interruptions are typed events** — an incoming call/assistant steals the mic
  on both OSes; the port emits pause/resume up the socket.
- **Resample on-device** to 16 kHz (also halves upload bandwidth).
- **OEM variance is a test matrix, not code** — mic tuning differs
  (Samsung/Pixel/Xiaomi); the Phase 3 word-overlap accuracy gates re-run on real
  room audio. First matrix rows: Gustavo's Android + the test iPhone.

## Store/policy consequences

`RECORD_AUDIO` + mic permission strings, a privacy policy URL, Play's
data-safety form, and the foreground-service declaration (Android 14+) all
become mandatory at store submission. Raw audio is never persisted
(transcript-only storage — the `[no-disk]` audits already enforce this
server-side; the same rule binds the phone).
