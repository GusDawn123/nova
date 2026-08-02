# Nova UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Nova mobile app's five screens and every state around the ratified design: `#0002DA` duotone mirror themes, Orbitron/Inter/Space Mono, chamfered controls, the one-button split cockpit, crisp-terminal streaming, and the hologram mascot.

**Architecture:** A token spine (`design/tokens.ts`) feeds shared primitives (`ChamferSurface`, `StreamingText`, `ThinkingIndicator`, `MascotStage`, `LightSweep`, `RingOrbit`) which the five screens compose. All animation logic lives in pure, co-located-tested scheduler modules; Reanimated components consume them. Screens stay dumb; the existing hooks (`use-meetings`, `use-meeting-notes`, `use-live-session`) are NOT rewritten — only their presentation is.

**Tech Stack:** Expo SDK 57 / React Native, `react-native-svg` (new, Expo-bundled), `react-native-reanimated` (present), `@expo-google-fonts/{orbitron,inter,space-mono}` (new), vitest + `@testing-library/react` over react-native-web in jsdom (existing harness).

**Spec:** `docs/superpowers/specs/2026-08-02-nova-ui-design.md` — binding. Where this plan and the spec disagree, the spec wins.

## Global Constraints

- Branch: `dev-claude-ui-design`. Commit after every task (small commits per repo memory). Never push without being asked.
- Strict duotone: canvas + ink only. Cobalt theme: canvas `#0002DA`, ink `#FFFFFF`. Paper theme: canvas `#FFFFFF`, ink `#0002DA`. NO other color literal anywhere — every value flows through `design/tokens.ts` (repo hard rule).
- Errors/success are words, never colors.
- Interactive = chamfered (cut 8px, large keys 10px); content cards = soft radius 13–16px.
- All motion respects `useReducedMotionValue()` from `design/motion.ts` (the shared store already exists): reduce-motion ⇒ no glitch/sweep/float, text appears in completed phrases, states cut instantly.
- Stream drain: ~60 chars/sec base, catch-up acceleration, caret vanishes on completion (that IS the done signal).
- TypeScript strict, no `any`; tests co-located `*.test.ts(x)`; soft cap ~400 lines/file; comments state constraints only.
- Verification for every task, from repo root: `npx vitest run apps/mobile/src` then `npm run typecheck` then `cd apps/mobile && npx expo lint`. All three clean before commit.
- Do NOT touch `apps/server/**` or `packages/shared/**` (backend wire changes are explicitly out of scope, spec §10).

## File Structure (target)

```
apps/mobile/src/design/
  tokens.ts            (rebuilt: duotone palettes, font trio, Chamfer, type scale)
  chamfer.tsx          (NEW: ChamferSurface + chamferPoints + CornerBrackets)
  motion.ts            (existing store kept; gains glitch/blink timeline helpers)
  ring-orbit.tsx       (NEW: double-ring spinner)
  light-sweep.tsx      (NEW: traveling gradient line)
  scanlines.tsx        (NEW: hologram overlay)
  glass.tsx            (existing; consumers re-tokened only)
apps/mobile/src/features/stream/
  drain.ts             (NEW: pure drain buffer)
  streaming-text.tsx   (NEW: crisp terminal + caret)
  thinking.ts          (NEW: pure word-cycle cadence)
  thinking-indicator.tsx (NEW: glass lines + word cycle)
apps/mobile/src/features/mascot/
  blink-clock.ts       (NEW: pure randomized blink/glitch scheduler)
  mascot-stage.tsx     (NEW: her — float, sparkles, scanlines, blink, glitch)
apps/mobile/src/app/(auth)/sign-in.tsx, sign-up.tsx   (rebuilt presentation)
apps/mobile/src/app/(app)/(tabs)/account.tsx           (rebuilt presentation)
apps/mobile/src/app/(app)/(tabs)/index.tsx             (rebuilt presentation)
apps/mobile/src/app/(app)/meetings/[id].tsx            (rebuilt presentation)
apps/mobile/src/app/(app)/(tabs)/live.tsx              (rebuilt presentation)
apps/mobile/src/components/app-tabs.tsx                (re-skinned)
apps/mobile/assets/mascot/eye-patch.png                (NEW: generated asset)
```

---

### Task 1: Fonts and svg dependency

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `apps/mobile/src/app/_layout.tsx` (font loading)

**Interfaces:**
- Produces: loaded font families `Orbitron_700Bold`, `Orbitron_900Black`, `Inter_400Regular`, `Inter_600SemiBold`, `Inter_700Bold`, `SpaceMono_400Regular`, `SpaceMono_700Bold`; `react-native-svg` importable.

- [ ] **Step 1: Install**

```bash
cd apps/mobile && npx expo install react-native-svg @expo-google-fonts/orbitron @expo-google-fonts/inter @expo-google-fonts/space-mono
```

- [ ] **Step 2: Load fonts in the root layout**

Read `apps/mobile/src/app/_layout.tsx` first — it already loads Spline Sans via `useFonts`. Replace the loaded set (keep Spline Sans TEMPORARILY alongside — old screens still reference it until their tasks land; it is removed in Task 14):

```tsx
import { Orbitron_700Bold, Orbitron_900Black } from '@expo-google-fonts/orbitron';
import { Inter_400Regular, Inter_600SemiBold, Inter_700Bold } from '@expo-google-fonts/inter';
import { SpaceMono_400Regular, SpaceMono_700Bold } from '@expo-google-fonts/space-mono';
// add all seven to the existing useFonts call, keeping the current entries
```

- [ ] **Step 3: Verify** — the three verification commands; expo lint must not flag unused imports (they are used by the hook call).

- [ ] **Step 4: Commit** — `feat(mobile): load the Nova font trio + svg`

---

### Task 2: The token spine

**Files:**
- Modify: `apps/mobile/src/design/tokens.ts` (rebuild in place)
- Test: `apps/mobile/src/design/tokens.test.ts` (extend existing if present, else create)
- Modify: every current consumer of removed fields — mechanical migration (grep `accent|screenGradient` under `apps/mobile/src`)

**Interfaces:**
- Produces (exact — later tasks import these):

```ts
export type ThemeName = 'cobalt' | 'paper';
export const BRAND_BLUE = '#0002DA';
export const BRAND_WHITE = '#FFFFFF';
export interface Palette {
  canvas: string;   // theme background
  ink: string;      // full-strength foreground
  inkSoft: string;  // 75% — secondary text
  inkFaint: string; // 45% — placeholders, disabled
  inkHairline: string; // 35% — borders, dividers
  inkFill: string;  // 10% — card fills, chip fills
  onInk: string;    // text/glyphs ON ink-filled controls (= canvas)
}
export function paletteFor(scheme: 'light' | 'dark' | null | undefined): Palette; // name kept
export const FontFamily: {
  display: 'Orbitron_900Black'; displayMid: 'Orbitron_700Bold';
  body: 'Inter_400Regular'; bodySemibold: 'Inter_600SemiBold'; bodyBold: 'Inter_700Bold';
  mono: 'SpaceMono_400Regular'; monoBold: 'SpaceMono_700Bold';
};
export const FontSize: { displayXl: 26; displayLg: 21; displayMd: 16; displaySm: 15;
  body: 15; bodySm: 13.5; bodyXs: 12.5; mono: 11; monoSm: 10; monoXs: 8.5 };
export const Chamfer: { control: 8; key: 10 };
// Space, Radius, Size: KEEP existing exports unchanged (screens rely on them).
export const eyebrowStyle: { fontFamily: 'SpaceMono_400Regular'; fontSize: 10;
  letterSpacing: 2; textTransform: 'uppercase' };
```

- [ ] **Step 1: Write the failing test**

```ts
// apps/mobile/src/design/tokens.test.ts (add these cases)
import { BRAND_BLUE, paletteFor, FontFamily, Chamfer } from './tokens';

it('cobalt and paper are exact mirrors of the two brand constants', () => {
  const cobalt = paletteFor('dark');
  const paper = paletteFor('light');
  expect(cobalt.canvas).toBe(BRAND_BLUE);
  expect(cobalt.ink).toBe('#FFFFFF');
  expect(paper.canvas).toBe('#FFFFFF');
  expect(paper.ink).toBe(BRAND_BLUE);
  expect(cobalt.onInk).toBe(cobalt.canvas);
  expect(paper.onInk).toBe(paper.canvas);
});

it('derived opacities stay in the declared bands', () => {
  for (const p of [paletteFor('dark'), paletteFor('light')]) {
    expect(p.inkFill).toMatch(/0\.10?\)$/);
    expect(p.inkHairline).toMatch(/0\.35\)$/);
  }
});

it('the font trio is the brand trio', () => {
  expect(FontFamily.display).toBe('Orbitron_900Black');
  expect(FontFamily.body).toBe('Inter_400Regular');
  expect(FontFamily.mono).toBe('SpaceMono_400Regular');
  expect(Chamfer.control).toBe(8);
});
```

- [ ] **Step 2: Run** — expect FAIL (old palette shape).
- [ ] **Step 3: Rebuild tokens.ts.** Derived values are literal rgba strings per theme (cobalt: `rgba(255,255,255,X)`; paper: `rgba(0,2,218,X)`). Delete `screenGradient`, `screenGradientLocations`, `darkPalette`/`lightPalette` old fields (`accent`, `accent2`, `accentSoft`, `accentGlow`, `accentFill`, `onAccent`). Keep `Space`, `Radius`, `Size` byte-identical. Update `eyebrowStyle` fontFamily to the new mono.
- [ ] **Step 4: Mechanical migration.** Grep all consumers of deleted fields; map: `accent→ink`, `onAccent→onInk`, `accentFill→inkFill`, `accentSoft→inkHairline`, `accentGlow→inkFill`, `accent2→ink`, `screenGradient`→ plain `palette.canvas` background. Old screens will look wrong-but-duotone until their tasks; they must COMPILE and their tests pass (update test expectations that assert removed values).
- [ ] **Step 5: Verify** — three commands clean. Existing screen snapshots/assertions that named old colors get updated in the same commit.
- [ ] **Step 6: Commit** — `feat(mobile): the duotone token spine — one blue, one white, two mirrors`

---

### Task 3: ChamferSurface

**Files:**
- Create: `apps/mobile/src/design/chamfer.tsx`
- Test: `apps/mobile/src/design/chamfer.test.tsx`

**Interfaces:**
- Produces:

```tsx
export function chamferPoints(w: number, h: number, cut: number): string;
// "8,0 W,0 W,H-8 W-8,H 0,H 0,8" — top-left and bottom-right corners cut (matches mockups)
export function ChamferSurface(props: {
  cut?: number;                    // default Chamfer.control
  fill?: string;                   // default 'transparent'
  stroke?: string;                 // default palette-independent: caller passes
  strokeWidth?: number;            // default 1
  brackets?: boolean;              // focus corner brackets (top-left, bottom-right)
  style?: StyleProp<ViewStyle>;    // outer layout style
  children?: ReactNode;
}): React.JSX.Element;
```

- [ ] **Step 1: Failing tests**

```tsx
// chamfer.test.tsx
import { render } from '@testing-library/react';
import { chamferPoints, ChamferSurface } from './chamfer';

it('cuts exactly the two opposite corners', () => {
  expect(chamferPoints(100, 40, 8)).toBe('8,0 100,0 100,32 92,40 0,40 0,8');
});

it('clamps the cut so tiny surfaces stay convex', () => {
  expect(chamferPoints(10, 10, 8)).toBe('5,0 10,0 10,5 5,10 0,10 0,5'); // cut clamped to min(w,h)/2
});

it('renders children and an svg polygon', () => {
  const { container, getByText } = render(
    <ChamferSurface fill="#0002DA"><></>{/* RN Text via harness */}</ChamferSurface>,
  );
  // follow the repo harness pattern from glass.test.tsx for rendering RN + asserting svg presence
  expect(container.querySelector('polygon')).toBeTruthy();
});
```

(Adapt the third test to the exact harness idioms in `glass.test.tsx` — read it first; keep the two pure assertions verbatim.)

- [ ] **Step 2: Run** — FAIL (module missing).
- [ ] **Step 3: Implement.** Outer `View` with `onLayout` capturing w/h into state; when measured, absolutely-positioned `<Svg>` behind children rendering `<Polygon points={chamferPoints(w,h,cut)} fill stroke strokeWidth/>`; brackets = two `<Polyline>` L-shapes (7px arms, strokeWidth 2, ink) at the cut corners. Children render in a padded inner View; `pointerEvents="none"` on the Svg layer.
- [ ] **Step 4: Run** — PASS. **Step 5: Verify + commit** — `feat(mobile): ChamferSurface — sharp is actionable`

---

### Task 4: LightSweep, RingOrbit, Scanlines

**Files:**
- Create: `apps/mobile/src/design/light-sweep.tsx`, `ring-orbit.tsx`, `scanlines.tsx`
- Test: `apps/mobile/src/design/light-sweep.test.tsx` (one file covers render contracts of all three)

**Interfaces:**
- Produces:

```tsx
export function LightSweep(props: { color: string; height?: number; durationMs?: number; style?: StyleProp<ViewStyle> }): React.JSX.Element; // thin track + traveling bright band; static faint line when reduced motion
export function RingOrbit(props: { size?: number; color: string }): React.JSX.Element;      // outer steady ring + inner rotating arc; static double ring when reduced motion
export function Scanlines(props: { color: string; opacity?: number }): React.JSX.Element;    // absolute-fill 1px/4px horizontal lines (Svg pattern of <Rect>s)
```

- [ ] **Step 1: Failing render tests** — each mounts, asserts structure (sweep: a track View + band; orbit: two ring nodes; scanlines: >10 rect lines for a 100px height) and asserts the reduced-motion branch renders (mock `useReducedMotionValue` to return true, assert no Animated node — follow how `motion.ts` consumers are tested, read `meeting-card.tsx` usage first).
- [ ] **Step 2: FAIL → Step 3: Implement** with Reanimated loops gated exactly like `useShimmer(_, running)` (reuse that gating pattern from `motion.ts`). Scanlines is static Svg — no animation.
- [ ] **Step 4: PASS → Step 5: Verify + commit** — `feat(mobile): sweep, orbit, scanlines — the motion instruments`

---

### Task 5: The stream drain (pure)

**Files:**
- Create: `apps/mobile/src/features/stream/drain.ts`
- Test: `apps/mobile/src/features/stream/drain.test.ts`

**Interfaces:**
- Produces:

```ts
export interface StreamDrain {
  push(text: string): void;   // socket tokens land here, any size
  end(): void;                // no more input; onDone fires when buffer empties
  dispose(): void;            // cancel timers
}
export function createStreamDrain(opts: {
  onText(chunk: string): void;   // drained characters, 1-3 per tick
  onDone(): void;
  baseCps?: number;              // default 60
  now?: () => number;            // injectable clock for tests
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}): StreamDrain;
```

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createStreamDrain } from './drain';

it('drains a burst at a steady character rate, not all at once', () => {
  vi.useFakeTimers();
  const out: string[] = [];
  const d = createStreamDrain({ onText: (c) => out.push(c), onDone: () => {} });
  d.push('Honestly, because the problems');
  vi.advanceTimersByTime(50);
  const after50 = out.join('').length;
  expect(after50).toBeGreaterThan(0);
  expect(after50).toBeLessThan(10); // ~60cps → ~3 chars in 50ms, never the whole burst
  vi.advanceTimersByTime(2000);
  expect(out.join('')).toBe('Honestly, because the problems');
  d.dispose(); vi.useRealTimers();
});

it('accelerates when the buffer backs up (catch-up)', () => {
  vi.useFakeTimers();
  const out: string[] = [];
  const d = createStreamDrain({ onText: (c) => out.push(c), onDone: () => {} });
  d.push('x'.repeat(400)); // deep backlog
  vi.advanceTimersByTime(1000);
  expect(out.join('').length).toBeGreaterThan(90); // faster than base 60cps
  d.dispose(); vi.useRealTimers();
});

it('onDone fires only after end() AND an empty buffer', () => {
  vi.useFakeTimers();
  let done = false;
  const d = createStreamDrain({ onText: () => {}, onDone: () => { done = true; } });
  d.push('abc'); d.end();
  expect(done).toBe(false);
  vi.advanceTimersByTime(500);
  expect(done).toBe(true);
  d.dispose(); vi.useRealTimers();
});
```

- [ ] **Step 2: FAIL → Step 3: Implement.** Tick loop via `schedule` (default setTimeout ~16ms): per tick emit `n = max(1, round(cps * dtMs / 1000))` chars where `cps = baseCps * (1 + min(buffer.length / 80, 2))`; stop scheduling when buffer empty and not ended; re-arm on push.
- [ ] **Step 4: PASS → Step 5: Verify + commit** — `feat(mobile): the stream drain — bursts in, steady flow out`

---

### Task 6: StreamingText

**Files:**
- Create: `apps/mobile/src/features/stream/streaming-text.tsx`
- Test: `apps/mobile/src/features/stream/streaming-text.test.tsx`

**Interfaces:**
- Consumes: `createStreamDrain` (Task 5), `FontFamily/FontSize` (Task 2), `useReducedMotionValue` (`design/motion.ts`).
- Produces:

```tsx
export function StreamingText(props: {
  text: string;         // the accumulated text so far (grows as deltas arrive)
  done: boolean;        // upstream says the stream completed
  color: string;        // ink
  style?: StyleProp<TextStyle>;
}): React.JSX.Element;
// Contract: renders the DRAINED prefix of `text` + a block caret while drained < text
// or !done. Caret unmounts when done && fully drained. Reduced motion: render `text`
// directly, caret only while !done. **Bold spans:** `**term**` markers in `text`
// render bold (Inter 700) — the server sends markdown bold; parse only `**`.
```

- [ ] **Step 1: Failing tests** — (a) feed growing `text` props with fake timers, assert rendered text lags then catches up; (b) caret present while streaming (`getByTestId('stream-caret')`), gone after `done` + drain; (c) `**bold**` renders a nested Text with `FontFamily.bodyBold`; (d) reduced-motion shows full text instantly. Write them concretely against the harness idioms (read `use-live-session.test.ts` FakeSocket file for the fake-timer patterns first).
- [ ] **Step 2: FAIL → Step 3: Implement.** `useEffect` diffing `props.text` growth → `drain.push(newSuffix)`; `done` → `drain.end()`; drained state via `useState` string append; caret = 7×15 View, ink background, opacity via 0.9s step Reanimated loop (gated). Parse `**` into segments before render.
- [ ] **Step 4: PASS → Step 5: Verify + commit** — `feat(mobile): crisp terminal streaming — the caret rides the write-head`

---

### Task 7: Thinking cadence + indicator

**Files:**
- Create: `apps/mobile/src/features/stream/thinking.ts`, `thinking-indicator.tsx`
- Test: `apps/mobile/src/features/stream/thinking.test.ts`, `thinking-indicator.test.tsx`

**Interfaces:**
- Produces:

```ts
export const THINKING_WORDS = ['LISTENING', 'READING THE MOMENT', 'COMPOSING'] as const;
export function thinkingWordAt(elapsedMs: number): string; // 820ms cadence, wraps
```
```tsx
export function ThinkingIndicator(props: { color: string; fillColor: string }): React.JSX.Element;
// Word (Space Mono, flick on swap) above three glass bars (92/78/45% width, inkFill,
// staggered sweeps via LightSweep). Parent unmounts it at handoff; the 240ms fade-out
// is the parent's (Task 13) exit animation, not this component's concern.
```

- [ ] **Step 1: Failing tests** — `thinkingWordAt(0)==='LISTENING'`, `(900)==='READING THE MOMENT'`, `(2500)==='COMPOSING'`, `(2460+820)` wraps to `'LISTENING'`; indicator renders 3 bars + the current word, advances on fake timers.
- [ ] **Step 2: FAIL → Step 3: Implement** (interval updates elapsed; flick = 220ms opacity/translate spring gated on reduced motion).
- [ ] **Step 4: PASS → Step 5: Verify + commit** — `feat(mobile): thinking — she narrates while the silhouette forms`

---

### Task 8: The blink patch asset

**Files:**
- Create: `apps/mobile/assets/mascot/eye-patch.png` (generated) + `scripts/make_blink_patch.sh` (generator)

- [ ] **Step 1: Write the generator** — `scripts/make_blink_patch.sh` (match `strip_mascot_bg.sh` style): uses `uv run --with pillow python` to crop the eye region from `apps/mobile/assets/mascot/eyes-closed.png` (the TRANSPARENT one) at `box = (400, 545, 860, 720)` and save `eye-patch.png`, then composite a PREVIEW: eyes-open base + patch pasted at (400,545), saved to the scratchpad as `blink-preview.png`.
- [ ] **Step 2: Run it, then VIEW `blink-preview.png` with the Read tool.** The preview must look like her with closed eyes and NO visible seam rectangle. If the box clips an eyelash or catches a hair edge, adjust the box ±20px and regenerate until clean. Record the final box in a comment in the script.
- [ ] **Step 3: Commit** — `feat(mobile): the blink patch — her eyes, cut for the cross-fade`

---

### Task 9: MascotStage

**Files:**
- Create: `apps/mobile/src/features/mascot/blink-clock.ts`, `mascot-stage.tsx`
- Test: `apps/mobile/src/features/mascot/blink-clock.test.ts`, `mascot-stage.test.tsx`

**Interfaces:**
- Consumes: `Scanlines` (Task 4), eye-patch + frames (Task 8), `useReducedMotionValue`.
- Produces:

```ts
export interface BlinkEvent { delayMs: number; double: boolean }
export function createBlinkClock(rng?: () => number): { next(): BlinkEvent };
// delayMs uniform 2000-6000; double true ~25%; deterministic given rng
```
```tsx
export function MascotStage(props: { size?: number; sparkles?: boolean }): React.JSX.Element;
// Renders: glow, eyes-open base (expo-image), eye-patch overlay (opacity 0, flips 1
// for ~140ms per blink; double = two closes 180ms apart), Scanlines, and during each
// blink a ~200ms glitch: two ghost copies translateX ±4, one slice band translateX,
// tracking line sweep, ±2px jitter — ONE timeline per blink event so blink and
// glitch cannot drift. Reduced motion: static eyes-open + scanlines only.
```

- [ ] **Step 1: Failing tests** — blink-clock: with `rng = () => 0.5` assert `next()` returns `{delayMs: 4000, double: false}`; with `rng = () => 0.9` assert `double: true` and delay 5600. mascot-stage: `vi.mock('react-native-reanimated', ...)` using the library's official mock (`require('react-native-reanimated/mock')` — first time in this repo; add the mock inline in this test file, NOT globally); assert base image + patch + scanlines render, and reduced-motion renders no ghost/slice/tracking nodes (testIDs: `mascot-ghost-a`, `mascot-slice`, `mascot-track`).
- [ ] **Step 2: FAIL → Step 3: Implement** (sequence: schedule next blink via clock → run one Reanimated timeline: patch opacity + ghosts + slice + track + jitter with the demo's offsets from `mascot-alive-v2.html` — ±4-5px ghosts, 3-position slice, top-to-bottom track).
- [ ] **Step 4: PASS → Step 5: Verify + commit** — `feat(mobile): MascotStage — she breathes, blinks, and tears like a hologram`

---

### Task 10: Sign-in, sign-up, account

**Files:**
- Modify: `apps/mobile/src/app/(auth)/sign-in.tsx`, `sign-up.tsx`, `apps/mobile/src/app/(app)/(tabs)/account.tsx`
- Test: co-located `.test.tsx` for each (extend existing where present)

**Interfaces:**
- Consumes: `ChamferSurface`, `MascotStage` (small, `sparkles`), tokens.

Layout (sign-in; sign-up mirrors with confirm field):
- Centered column on `palette.canvas`: `MascotStage size={120}` inside a drawn double ring (two nested border-circle Views, `inkHairline`/`ink`), `NOVA` in `FontFamily.display` size `FontSize.displayXl` letterSpacing 8, `YOUR LIVE-CALL COPILOT` eyebrow, two fields (each a `ChamferSurface stroke=inkHairline brackets={focused}` wrapping `TextInput` in `FontFamily.mono` `FontSize.mono` color ink, placeholderTextColor `inkFaint`), submit key (`ChamferSurface cut={Chamfer.key} fill=ink` + Text in `FontFamily.display` color `onInk`), mono footer link. Field errors: plain copy below in `inkSoft`, field stroke flips to full `ink` — no red.
- Account: soft cards (Radius 14, `inkFill` bg): signed-in-as, plan + `ACTIVE` chamfered chip, Appearance row cycling `COBALT / PAPER / AUTO` (persist via the existing scheme mechanism — read how the app currently resolves `useColorScheme`; if there is no override mechanism, add a simple context-backed override in this task, stored with `@react-native-async-storage/async-storage` which is already a dependency), sign-out (chamfered outline), delete-account mono whisper.

- [ ] **Step 1: Failing tests** — sign-in renders wordmark + both fields + key; submit-disabled while fields empty (preserve existing auth logic — presentation only); error state shows plain copy and NO hex outside tokens (assert no `#f`/`red` in rendered styles); account renders theme row and cycles labels on press.
- [ ] **Step 2: FAIL → Step 3: Rebuild presentation** (keep every existing handler/hook call; only the JSX + styles change).
- [ ] **Step 4: PASS → Step 5: Verify + commit** — one commit per screen file: `feat(mobile): the front door, in brand`, `feat(mobile): account — the quiet screen`

---

### Task 11: Meetings list

**Files:**
- Modify: `apps/mobile/src/app/(app)/(tabs)/index.tsx`, `apps/mobile/src/features/meetings/meeting-card.tsx`
- Test: extend `apps/mobile/src/features/meetings/meeting-card.test.tsx` + screen test

**Interfaces:**
- Consumes: `LightSweep`, `MascotStage`, `ChamferSurface`, tokens; existing `use-meetings` (unchanged), `groupMeetingsByRecency` (unchanged).

Presentation:
- Header: `MEETINGS` (`display`, `displayMd`), right `N this month` (`mono`, `monoSm`, `inkSoft`).
- Group eyebrows: `— Today —` centered mono.
- Card: soft (Radius 14, border `inkHairline`; today's cards get `inkFill`): title `bodySemibold`; meta line mono `monoXs` `inkSoft` (`2:14 PM · 32 min · Finance`); optional preview line `bodyXs` `inkSoft`. Status: notes ready → small chamfered chip fill=ink text=onInk `NOTES READY`; **processing → `LightSweep` under the title + `WRITING NOTES` mono in the meta row — NO chip** (delete the old chip branch); failed → plain words in meta.
- States: empty → `MascotStage size={220}` + `NO CALLS YET` display + the ratified copy (`Your first call becomes your first memory. I'll keep the notes.`) + chamfered `◉ START A SESSION` key routing to the Live tab; loading → 3 skeleton cards (inkFill bars + slow `useShimmer`); error → soft card + chamfered RETRY wired to `refresh`; signed-out → copy card, NO retry (state already exists in the hook).

- [ ] **Step 1: Failing tests** — processing card renders sweep + `WRITING NOTES` and NOT `PROCESSING`; ready card renders the chip; empty state renders mascot + copy + key; signed-out renders no retry button.
- [ ] **Step 2: FAIL → Step 3: Rebuild presentation. Step 4: PASS → Step 5: Verify + commit** — `feat(mobile): meetings — the archive, sweep not chip`

---

### Task 12: Meeting detail

**Files:**
- Modify: `apps/mobile/src/app/(app)/meetings/[id].tsx` (+ its feature components under `features/meetings`/`features/notes` as currently structured — read the screen first and re-skin where the JSX actually lives)
- Test: extend the co-located tests

Presentation per spec §5: back eyebrow, title block, chamfered tab pills (`NOTES · TRANSCRIPT · FOLLOW-UP`, selected = fill ink/text onInk, `accessibilityRole="tab"` + `aria-selected` per the existing a11y pattern), TL;DR card (inkFill), action items with chamfered 13px checkboxes (ChamferSurface cut 4, checked: fill ink + `✓` in onInk; row strikes + `inkSoft`), Open card. Processing → `RingOrbit` + `She's re-reading the call. A minute, maybe two.` + transcript reachable; failed → `The notes didn't make it through` + chamfered TRY AGAIN + transcript readable; follow-up tab reuses `mapFollowUpFailure` kinds incl. `gone` as plain copy.

- [ ] **Step 1: Failing tests** — checkbox toggles call the existing `toggleItem` (logic unchanged); processing renders orbit + copy with transcript tab still enabled; `gone` renders its copy without a retry control.
- [ ] **Step 2: FAIL → Step 3: Rebuild. Step 4: PASS → Step 5: Verify + commit** — `feat(mobile): meeting detail — notes you can act on`

---

### Task 13: The Live cockpit

**Files:**
- Modify: `apps/mobile/src/app/(app)/(tabs)/live.tsx` + `apps/mobile/src/features/live-call/*` (read the current structure first; the mode picker component is kept and re-skinned)
- Test: extend co-located tests

**Interfaces:**
- Consumes: everything — `ChamferSurface`, `StreamingText`, `ThinkingIndicator`, tokens; existing `use-live-session` (`start`, `sendInput`, session state, suggestion stream, notes panel wiring — UNCHANGED).

Presentation per spec §4:
- Idle: mode pills (chamfered; picked = ink fill), `START SESSION` key, `MascotStage` NOT here (working surface).
- Live: header wordmark + `◉ LIVE · mm:ss` HUD; transcript card (latest turn full ink, older `inkSoft`/`inkFaint`); HUD rail (hairline — MODE — hairline); copilot history (existing history model): answer card = soft, newest border ink 1.5 + `inkFill`, label `◆ NOVA · SAY THIS` eyebrow, body via `StreamingText` (feed the entry's accumulated text + done flag); while a request is in flight and no text yet → `ThinkingIndicator` inside the newest card, unmounted with a 240ms fade as the first delta lands (caret-first handoff); steer chip = white rounded chip (`ink` bg, `onInk` text, corner radius 14/14/3/14) right-aligned above its answer.
- Bottom bar: chamfered steer field (mono, placeholder `Steer the answer (optional)…`, brackets on focus) + `◉ RESPOND` key (Chamfer.key, fill ink, `display` font, disabled at `inkFaint` fill).
- **MVP bridge (until the backend workstream):** RESPOND is enabled only when the steer field is non-empty and submits via the EXISTING `sendInput(steer)`; the steer renders as the chip. Incoming conductor suggestions render as normal `◆` cards. A `// why:` comment marks the bridge and names spec §10.
- States: degraded/disconnected → mono banner line under the HUD rail; quota-exceeded → full-screen card, plain copy, no retry; ended → summary row + `WRITING NOTES` sweep + link to the meeting.

- [ ] **Step 1: Failing tests** — RESPOND disabled when field empty; typing + submit calls `sendInput` with the steer and renders the chip; a streaming entry renders `StreamingText` with caret; pre-first-delta renders `ThinkingIndicator`; quota-exceeded state renders its copy with no retry control. (Extend the existing FakeSocket tests — read them first; they already simulate suggestion streams.)
- [ ] **Step 2: FAIL → Step 3: Rebuild. Step 4: PASS → Step 5: Verify + commit** — `feat(mobile): the cockpit — one button, a caret, and the words`

---

### Task 14: Tab bar, transitions, font retirement, docs

**Files:**
- Modify: `apps/mobile/src/components/app-tabs.tsx`, `apps/mobile/src/app/_layout.tsx`, `apps/mobile/package.json`, `CLAUDE.md`
- Test: extend `app-tabs` tests

- [ ] **Step 1:** Re-skin tabs: labels in `mono`/`monoXs` (`▤ MEETINGS`, `◉ LIVE`, `◌ ACCOUNT`), selected full ink + `aria-selected` (pattern already landed), record dot unchanged. Screen transitions: 200ms fade via the stack navigator options (`animation: 'fade'`).
- [ ] **Step 2:** Remove Spline Sans packages + their `useFonts` entries; grep proves zero remaining consumers.
- [ ] **Step 3:** Full check: `export $(grep -E "^SUPABASE_" apps/server/.env | xargs) && npm run check` — green.
- [ ] **Step 4:** Update CLAUDE.md: a UI paragraph (the redesign, the spec path, the deferred backend follow-ups) in the same voice as existing entries.
- [ ] **Step 5: Commit** — `feat(mobile): the last mile — tabs, transitions, and the old face retired`

---

## Self-review (done during writing)

- Spec coverage: §2→T2, §3→T3, §4→T13, §5→T11/12, §6→T4/5/6/7 (+T9 glitch), §7→T8/9, §8→T10, §9→T2, §10 fenced (T13 bridge), §11 held throughout (reduced-motion in every motion task; no new native modules beyond expo-bundled svg).
- No placeholders: every task carries code or an exact read-first pointer to the file whose idiom it must copy.
- Type consistency: `Palette` fields, `ChamferSurface` props, `StreamDrain`, `ThinkingIndicator`, `MascotStage`, `createBlinkClock` are each defined once in their producing task and referenced by name downstream.
