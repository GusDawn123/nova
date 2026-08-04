# Nova UI brainstorm — working notes (2026-08-02)

## Locked so far
- **Canvas**: dark mode = cobalt canvas (logo blue ~#2733E6, exact hex to be sampled from logo file), white ink. Light mode = paper inverse (white canvas, cobalt ink). Strict duotone, mirror themes. No third color.
- **Type**: Orbitron (display: wordmark, titles, mode pills) / Inter (body — everything the user reads aloud) / Space Mono (labels, HUD, timestamps).
- **Brand depth**: "character in the moments" — mascot/anime energy lives in states (empty, loading, error) and brand moments; working surfaces stay clean duotone.
- **Scope**: five core screens (sign-in/up, meetings list, meeting detail, live, account) + ALL states of each. No onboarding flow, no upgrade moments, no post-call celebration this pass.
- **Live screen layout**: SPLIT COCKPIT — transcript pane (top) + copilot pane (bottom), HUD rail divider (mode · timer · live status).

## SUPERSEDED by the MVP decision below — kept for history
## (was) Gustavo's three-lane interaction model (Live screen)
The Live screen has three distinct ways an answer gets produced, and they are
DIFFERENT INTENTS that must stay distinguishable in both UI and (later) wire/prompt:

1. **AUTO** — the conductor's triggered suggestions as the call flows (exists
   today). Label: "NOVA · SAY THIS". No user action.
2. **RESPOND button** — one tap, no typing: "answer the current moment NOW."
   Same intent as auto (speak as the user, answer the end of the transcript),
   but user-demanded — so it should bypass the trigger gate's quiet rules.
   Backend note: a manual-trigger wire event down the EXISTING answer path
   (same prompt, same metering); the gate treats it as always-fire.
3. **ASK NOVA chat** — the user TYPES A QUESTION TO NOVA mid-call ("what's a
   good counter to their number?", "what does EBITDA mean here?"). This is a
   SEPARATE ROUTE with a SEPARATE PROMPT: the model must know the USER is
   asking it for help — it answers the user's question, still in speakable
   first-person form so the user can read the answer out loud. It is NOT a
   fake "them" utterance. (Today's `transcript.input` injects typed text as a
   "them" turn — this three-lane model supersedes that assumption; the ask
   lane needs its own wire event + prompt-library entry, threaded through the
   same conductor/metering/latency machinery.)

UI consequences:
- Copilot-pane items carry provenance: auto/respond answers look identical
  (they are the same intent); ask exchanges render as a PAIR — the user's
  question as a small right-aligned chip, Nova's answer beneath it, labeled
  distinctly (e.g. "NOVA · FOR YOU").
- Bottom bar = Ask Nova input (chat pill) + RESPOND button as a separate,
  heavier control. They must not look like one widget: typing = asking,
  tapping = "answer them for me."
- All three lanes stream into the same scrollable copilot history; auto-scroll
  pinned unless the user scrolled up (existing behavior carries over).

## THE MVP INTERACTION MODEL (Gustavo, 2026-08-02 — binding; also saved to session memory)
**No auto responses.** One lane, one button:
- Tap **RESPOND** (input empty) → answer the current moment as the user.
- Type steering text + tap RESPOND → same call, steer folded in. The typed text
  is USER GUIDANCE on its own prompt path — never a fake "them" turn (the old
  `transcript.input` assumption is dead).
- Steering doubles as ask-Nova ("what's a good counter?" + RESPOND → speakable
  answer shaped by it).
- Conductor trigger-gate/speculation: dormant in MVP (speculation may pre-warm
  the button later). The latency budget (tap→first-token p50 ~800ms) is what
  makes button-first feel instant.
- UI: every history item user-initiated; steered answers show the steer as a
  white chip above the card; RESPOND is the hero control.

## Control language (locked 2026-08-02)
- **HUD chamfer** (option A): interactive elements get 45° clipped corners
  (clip-path), focus brackets on active fields, Space Mono input text, the
  RESPOND key filled white with a soft glow. Rule: SHARP = ACTIONABLE
  (buttons, fields, pills chamfered), SOFT = READABLE (content cards keep
  rounded radii). Bottom bar = chamfered steer field + chamfered ◉ RESPOND key.

## Motion system (locked 2026-08-02)
- **Text arrival: CRISP TERMINAL** — character-level stream, block caret rides
  the write-head top-to-bottom. Drain-buffer smoothing: socket tokens land in a
  buffer, UI drains at ~55-70 chars/sec with gentle catch-up; rare micro-pauses
  at token boundaries are honest. Caret vanishes on completion = the done signal.
- **Thinking state: GLASS LINES + WORD CYCLE combo** — cycling status words
  (LISTENING → READING THE MOMENT → COMPOSING, hologram flick on each swap)
  above three translucent shimmer bars (the answer's silhouette). Handoff is
  CARET-FIRST: lines fade 240ms, caret lands where the first character will,
  stream begins. Ring orbit (double-ring spinner) reserved for non-live waits.
- **Mascot: hologram identity** — always-on faint scanlines; ~200ms glitch tear
  synced to blinks (ghost echoes ±4-5px white/deep-blue, displaced slice,
  tracking line, scanline boost, ±2px jitter); blink = eye-region patch on a
  randomized 2-6s Reanimated clock (same clock drives glitch). Single-slice
  subtle variant = loading shimmer elsewhere.
- **Processing (meetings list): thin light-sweep** under the title + mono
  WRITING NOTES whisper — no boxed chip.
- **True brand hex: #0002DA** (sampled from logo; replaces #2733E6 guess).
- Asset pipeline: scripts/strip_mascot_bg.sh (rembg isnet-anime + alpha matting;
  --chroma fallback needs ImageMagick; raw bg is ~#0103D5 edge-varying).
  Transparent frames live at apps/mobile/assets/mascot/*.png (untracked yet).

## Open items (later in this brainstorm)
- Meetings list + meeting detail layout mockups.
- Sign-in/up + account in the new identity.
- State/mascot vocabulary (empty/loading/error) — where the girl appears.
- Motion: how text "arrives" (streaming), transitions, the live pulse.
- Exact hex sampling from logo; Orbitron weights; type scale.
