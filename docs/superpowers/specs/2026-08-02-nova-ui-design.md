# Nova UI — the design (2026-08-02)

Ratified section by section by Gustavo through live mockups (visual companion
session `.superpowers/brainstorm/21792-1785648574/` — the HTML files there are
the visual source of truth for every decision named below). This document is the
written contract for the implementation plan.

## 1. What this is

A ground-up visual redesign of the Nova mobile app (Expo / React Native) around
the brand: the AI girl who helps you live on a call. Five screens and every
state of each. The old UI is replaced, not themed — nothing in the current
screens is a reference point. Scope excludes: onboarding flows, upgrade/quota
purchase moments, post-call celebration (deliberately deferred), and any backend
work (the interaction model's wire/prompt changes are a separate workstream,
§10).

## 2. Brand foundation

**Color — strict duotone, two mirror themes.** ONE blue, ONE white, nothing
else, ever:

- Brand blue: **`#0002DA`** — sampled from the logo file (the previous `#2733E6`
  in early mockups was an eyeball guess; all mockups from `mascot-alive.html`
  on use the true hex, Gustavo-approved).
- **Cobalt theme (dark)**: canvas `#0002DA`, ink `#FFFFFF`. The logo IS the app.
- **Paper theme (light)**: canvas `#FFFFFF`, ink `#0002DA`. The logo inverted.
- Every intermediate value is an opacity of the theme's ink over its canvas
  (fills ~8-11%, hairlines ~30-45%, secondary text ~65-85%). No third color, no
  gradients except light-sweep effects (white at partial opacity).
- Theme names surface to the user in Account: **Cobalt / Paper / Auto**.

**Type — three voices:**

- **Orbitron** (700/900) — DISPLAY: wordmark, screen titles, mode pills, the
  RESPOND key. Futurism lives here and only here.
- **Inter** — BODY: everything the user reads aloud or at length. The
  teleprompter face; never stylized.
- **Space Mono** — LABELS: HUD rail, timestamps, status whispers, eyebrow
  labels (`◆ NOVA · SAY THIS`), input text in steer fields. Uppercase,
  letter-spaced.
- Loaded via `@expo-google-fonts/*`; rendered through tokens, never ad-hoc.

**The double ring** (from the logo badge) is a system element: empty-state
frame, non-live thinking spinner (ring orbit), badge holder. Drawn in code,
never baked into images.

## 3. Control language — sharp is actionable, soft is readable

- Interactive elements (buttons, fields, pills, checkboxes, chips) get the
  **HUD chamfer**: 45° clipped corners, plus focus **corner brackets** on
  active fields. Content cards (answers, notes, meeting rows) keep soft
  radii (13-16px).
- The bottom bar of the Live screen: chamfered steer field (Space Mono
  placeholder `Steer the answer (optional)…`, block caret) + the **◉ RESPOND
  key** — chamfered, ink-filled (white on Cobalt), Orbitron 900, soft outer
  glow. Two visibly distinct controls, never one merged pill.
- RN implementation note: React Native has no `clip-path`. Chamfers ship as a
  reusable `<ChamferSurface>` primitive backed by `react-native-svg` (polygon
  fill + stroke; corner brackets as short polylines). One component, used
  everywhere, so the geometry can't drift per-screen.

## 4. The Live screen — split cockpit, one button

Layout (top to bottom): status area → header (NOVA wordmark left; HUD right:
`◉ LIVE · mm:ss`) → **transcript pane** (soft card, `me`/`them` turns, latest
turn full-opacity, older turns fading) → **HUD rail divider** (hairline —
MODE — hairline) → **copilot pane** (scrollable history of answer cards,
newest at bottom, auto-scroll pinned unless the user scrolled up) → bottom
bar (steer field + RESPOND key).

**Interaction model (MVP, binding — no auto mode):**

- Nova NEVER speaks unprompted. The conductor's trigger-gate/speculation stays
  dormant.
- **Tap RESPOND, field empty** → answer the moment at the end of the
  transcript, as the user, teleprompter register.
- **Type a steer, tap RESPOND** → same call with the typed text folded in as
  USER GUIDANCE ("talk about the CLI features", "what's a good counter to
  their number?"). The steer renders as a white chip (rounded, right-aligned)
  above the resulting answer card. It is never a fake transcript turn.
- Answer cards: soft card, hairline border (newest gets full-ink 1.5px border +
  8-11% ink fill), label `◆ NOVA · SAY THIS` in Space Mono, body in Inter with
  1-3 **bolded key terms**.
- Pre-session (idle) state: mode pills (chamfered; picked = ink-filled),
  START SESSION key, last-session shortcut. Mode locks at session start
  (existing wire contract; picker already exists and re-skins).

**Live screen states:** idle/pre-session · live-streaming (motion §6) ·
degraded (STT vendor down → typed banner in mono, session continues) ·
quota-exceeded mid-call (typed close: full-screen card, plain copy, no dead
retry) · disconnected (auto-reconnect posture with mono status line) ·
session ended (summary handoff row: "notes are being written" + sweep, link
to the meeting).

## 5. Meetings — list and detail

**List:** recency-grouped (`— Today —`, `— This week —`, `— Earlier —` in mono
eyebrows), soft cards: title (Inter 600), meta line in mono (time · duration ·
mode), optional one-line notes preview. Status: `NOTES READY` = small chamfered
ink-filled chip; **processing = NO chip** — a thin light-sweep line under the
title + `WRITING NOTES` whispered in mono in the meta row. Header: `MEETINGS`
wordmark-style + `N this month` in mono.

**List states:** empty = mascot moment (§7: her figure, twinkling sparkles,
"Your first call becomes your first memory. I'll keep the notes.", one
chamfered START A SESSION key) · loading = three skeleton cards with slow
white shimmer · error = soft card, plain copy, chamfered RETRY · signed-out =
its own state (no dead retry; copy directs to sign-in).

**Detail:** back eyebrow, title block (title / meta in mono), chamfered tab
pills: NOTES · TRANSCRIPT · FOLLOW-UP. Notes view: TL;DR card (8-11% fill),
Action-items card with **chamfered checkboxes** (13px, tick = on-accent ink;
checked rows strike + dim), Open card. Transcript view: turn list, `me`/`them`
mono tags. States: processing = ring-orbit + "She's re-reading the call. A
minute, maybe two." with the transcript never blocked; failed = plain admission
+ chamfered TRY AGAIN + transcript still readable; notes absent (older
call) = quiet empty section, no ceremony. Follow-up tab: renders the draft
when present; its failure states reuse the `mapFollowUpFailure` kinds already
in the mobile code (including the non-retryable `gone`), each as plain copy in
the state-card pattern.

## 6. Motion system

All motion respects the existing reduced-motion store (one OS subscription);
with reduce-motion on: no glitch, no sweeps, no float — text appears in
completed phrases, states cut instantly.

- **Text arrival — CRISP TERMINAL.** Character-level stream; block caret rides
  the write-head from the first character, top to bottom. Smoothing: socket
  tokens land in a buffer; the UI drains at ~55-70 chars/sec, accelerating
  gently when the buffer backs up. Rare micro-pauses at token boundaries are
  acceptable (honest). **The caret vanishing IS the completion signal** — no
  separate done indicator.
- **Thinking state (live) — GLASS LINES + WORD CYCLE.** On RESPOND: status
  words cycle in Space Mono with a ~220ms hologram flick per swap —
  `LISTENING → READING THE MOMENT → COMPOSING` (~820ms cadence) — above three
  translucent shimmer bars (92/78/45% widths, staggered light sweeps).
  Handoff is CARET-FIRST: bars fade ~240ms, caret lands at the first
  character's position, stream begins. The label flips to `SAY THIS` at
  handoff.
- **Ring orbit** — the double-ring spinner (outer steady, inner arc rotating,
  1.1s) is the thinking indicator for every NON-live wait (notes processing,
  account operations).
- **Light sweep** — the traveling gradient line: processing rows in the
  meetings list, section reveals in notes, card entrances. Never on the
  teleprompter stream.
- **Screen transitions** — quiet: 180-220ms fades with 4-8px translate;
  the Live screen never animates content it didn't cause (one-button model
  guarantees this).

## 7. The mascot system — she is a hologram

- **Where she appears:** empty states, loading moments, error moments, sign-in.
  Never inside working surfaces mid-task ("character in the moments").
- **Assets:** raw art in `apps/mobile/assets/mascot/raw/` (1254×1254:
  `eyes-closed.png` = the logo art, `eyes-open.png` = the resting frame).
  Transparent versions produced by `scripts/strip_mascot_bg.sh` (rembg,
  `isnet-anime`, alpha-matting `-af 240 -ab 20 -ae 5`; `--chroma '#0103D5'`
  ImageMagick fallback; raw background is `~#0103D5` edge-varying, distinct
  from the canvas `#0002DA` — irrelevant once transparent). rembg keeps only
  the girl: the ring and sparkles are UI elements drawn in code.
- **Resting behavior:** eyes-open base; slow float (±5-6px, ~6.5s); sparkles
  (`✦` glyphs) twinkle on staggered 3.2s clocks; faint scanlines
  (1px/4px repeating, ~5% white) ride her constantly.
- **Blink:** eye-region PATCH from the closed-eyes frame cross-faded over the
  open-eyes base (never full-frame swap — generations aren't pixel-identical).
  Randomized clock: 2-6s intervals, ~140ms closes, occasional double-blink.
- **Glitch (her signature):** synced to the SAME clock as the blink, ~200ms:
  two ghost echoes split ±4-5px (one brightness-lifted, one darkened/saturated
  — stays in brand), one horizontal slice displaces through 2-3 positions, a
  tracking line snaps down the figure, scanlines double, the figure jitters
  ±2px. Implementation: one Reanimated timeline driving blink + glitch so they
  cannot drift. A single-slice subtle variant is available as a loading
  accent elsewhere.
- Demo reference: `mascot-alive-v2.html` (approved "ship as-is" intensity).

## 8. Sign-in / sign-up and Account

**Sign-in:** centered column — her transparent art small inside the drawn
double ring (with sparkles), NOVA wordmark (Orbitron 900, wide tracking),
`YOUR LIVE-CALL COPILOT` mono eyebrow, two chamfered fields (email/password,
corner brackets on focus), one SIGN IN key, mono footer link to create
account. Sign-up mirrors. Error states: plain copy under the field, field
border to full ink — no red (duotone holds; errors are words, not colors).

**Account:** quiet list of soft cards — signed-in-as, plan (+ `ACTIVE` chip),
**Appearance: Cobalt / Paper / Auto**, sign out (chamfered outline),
delete-account as a mono whisper. States: loading skeletons; operation
failures as inline plain copy.

## 9. Design tokens — the implementation spine

`apps/mobile/src/design/tokens.ts` is rebuilt (existing consumers migrate):

- `palette`: `canvas`, `ink`, plus derived opacities (`inkSoft`, `inkFaint`,
  `inkFill`, `inkHairline`, `onInk` for text on ink-filled controls) — computed
  per theme from the two brand constants. The old multi-accent palette dies.
- `FontFamily`: `display` (Orbitron), `body` (Inter), `mono` (SpaceMono).
- `Space`/`Radius`/`Size` keep their roles; add `Chamfer` (corner cut: 8px
  controls, 10px large keys).
- Type scale: display 26/21/16/15, body 15/13.5/12.5, mono 11/10/8.5 — exact
  values may tune ±1 at implementation against real devices; everything else
  in this spec is binding.
- ALL styling flows through tokens (existing repo rule; the CodeRabbit config
  enforces it).

## 10. Backend follow-ups (explicitly OUT of this UI build)

The one-button model needs, in a later server workstream: a manual-trigger
wire event (RESPOND — rides the existing answer path, bypasses the quiet
gate), a steer field on that event carried into the prompt as user guidance
(its own prompt-library handling — never a fake `them` turn; supersedes
`transcript.input`'s assumption), and prompt-pin repins per the established
mechanics. The UI ships against the EXISTING wire protocol first (typed input
+ existing events), with the steer chip rendering ready; the wire upgrade
swaps underneath.

## 11. Constraints and non-goals

- No third color anywhere, including errors and success (words carry meaning;
  ink carries emphasis).
- White-on-`#0002DA` and `#0002DA`-on-white both exceed WCAG AA for normal
  text; secondary text opacities stay ≥65% over canvas.
- Tap targets ≥44pt (Size.tapTarget = 46 exists); tab/selection semantics per
  the a11y patterns already landed (aria-selected + roles).
- The mascot never appears on the live call screen (glanceability is sacred).
- No new native modules for motion (Reanimated + expo-image + react-native-svg
  only; Rive explicitly deferred).
- Soft cap ~400 lines/file holds; ChamferSurface, the streamer, the mascot
  stage, and the thinking indicator are separate primitives.
