# CodeRabbit findings batch — report (2026-08-02)

Branch `dev-nova-ui-design`, PR base `development`. 55 findings verified against current
code. **42 fixed, 13 skipped.** Six commits, `1c93904..6f93d12`. `npm run check` green:
1292 passed / 210 skipped (DB + vendor-key gated) / 0 failed.

Every finding below was read against the file as it stands today, not against
CodeRabbit's quoted snippet.

---

## Major

| # | File | Verdict | Reason |
|---|---|---|---|
| F1 | `scripts/strip_mascot_bg.sh` | **fixed** | `#2733E6` corresponds to nothing in this repo. Decoded the raw art directly: `apps/mobile/assets/mascot/raw/*.png` is painted on ~`#0003D5`/`#0104D6`. Used the brand blue `#0002DA` (the real token, within the default `CHROMA_FUZZ` of the file's pixels) rather than CodeRabbit's `#0103D5`, and said so in the usage text. |
| F2 | plan doc — RESPOND on empty steer | **skipped** | Controller ruling: the steer-required key is the deliberate MVP bridge (mic capture is Phase 9, so there is no live transcript for an empty RESPOND to answer). Already ledgered as a product item. |
| F3 | `design/chamfer.tsx` | **fixed** | Real. Content was inset by the raw `cut` while the polygon drew `clampCut(w,h,cut)`, so on a surface under `2 × cut` the content sat outside the shape painted around it. Padding now follows the clamp once a box is measured; raw cut stands for the unmeasured first frame (nothing is drawn then either). New test pins a 10×10 surface to a 5pt inset. |
| F4 | `hooks/use-appearance.tsx` | **fixed** | Storage is a boundary and RULES §1 says parse it. `z.enum(APPEARANCE_ORDER)` replaces the hand-rolled `.find`, so the picker and the reader cannot offer different sets. |
| F5 | `testing/router-directory.test.ts` | **fixed** | Controller ruling put this in scope as the one low-risk DRY extraction. New `src/testing/repo-root.ts`; both structural suites import it. |
| F6 | `app/(app)/(tabs)/live.tsx` | **fixed** | Real. `closed` covers both "a call ended" and "a start never connected"; `cockpitView` already distinguishes them by `clock.ran`, but the header did not — so a failed start showed `◌ ENDED · 00:00` over the idle panel. New `hudStatus(status, ran)` maps that one case to `idle`. Test drives a clean close before `session.ready` and asserts STANDBY, plus the ENDED case beside it. |
| F7 | `components/app-tabs.test.tsx` | **fixed** | The two dot tests used `recordDotColor` as their own oracle. Rewritten against the literal tokens **and** against the surface actually rendered (`tab-live` fill / `tab-bar` slab), which is the property the dot exists for. |
| F8 | `components/app-tabs.tsx` | **fixed** | `TAB_BAR_HEIGHT` derived from `Size.tapTarget + Space.xs2 * 2`; new exported `tabBarFloatOffset(insetBottom)` is now the single source for both the bar's `bottom` and `tabBarClearance`. Test pins the two together. |
| F9 | `app/(auth)/sign-in.tsx` | **fixed** | Footer `Pressable` had no box of its own. `minHeight: Size.tapTarget` + centred. Mirrored onto `sign-up.tsx` (same footer, same gap). Test measures the rendered link. |
| F10 | `app/(app)/meetings/[id].tsx` | **fixed** | Back eyebrow had `paddingVertical: Space.sm` only. Added `minHeight: Size.tapTarget`; test asserts ≥44. |
| F11 | `features/meetings/state-card.tsx` | **fixed** | New co-located `state-card.test.tsx` (6 tests): no key without an action, the key's press passes through, `waiting` is the only thing that turns `RingOrbit`, a failure shows none, and `expectDuotoneOnly` over both palettes with the chamfered key and the ring drawn. |
| F12 | `features/meetings/format.test.ts` | **fixed** | Added the window's two edges (Jul 16 → `Thu`, Jul 15 → `Jul 15`) plus a midnight-boundary pair, and the matching pair for `groupMeetingsByRecency`, so the section a call was tapped from and the day printed on the detail screen cannot drift. |
| F13 | `features/stream/drain.test.ts` — helper extraction | **skipped** | Sound refactor, deferred to the next branch to keep this PR's risk profile flat. Recorded for the next branch. |
| F14 | `features/stream/drain.test.ts` — surrogates | **fixed** | Real. The `expect`s ran *inside* the drain's own timer callback, where a throw is swallowed and the test reports whatever the final string happens to be. Now collects chunks and asserts after, with `chunks.length > 1` proving the text was actually split. |
| F15 | `testing/duotone.ts` | **fixed** | **Real defect in the guard.** `asColor('white')` returned the raw `#ffffff` while every palette value was canonicalised to `rgb(…)` — so cobalt's own ink, spelled by name, was reported as a third colour. `NAMED_CANONICAL` now goes through `normaliseColor`; a test pins `white` passing and proves the fix is load-bearing. |
| F16 | `screen-tests/tabs-index.test.tsx` | **fixed** | The `useFocusEffect` mock now HOLDS the callback. New test sets the system clock, renders (`— Today —`), moves the clock two days, re-fires focus, and asserts the row moves to `— This week —`. Fails if the screen stops re-reading the clock. |
| F17 | `screen-tests/sign-up.test.tsx` | **fixed** | Mirrored sign-in's `realMascot` arrangement (real `MascotStage` for the duotone case only) plus the `@/design/motion` and `expo-image` mocks her layers need, so the colour guard runs over her gradients rather than over a box. |
| F18 | `screen-tests/tabs-live.test.tsx` | **fixed** | Checked `packages/shared/src/live.ts` first, as instructed: `transcriptInputSchema` carries `v`, `type`, `text`, `origin` and **no `session_id`** (the socket is the session). Added `v: LIVE_PROTOCOL_VERSION` only, with a comment saying why no session id is asserted. |
| F19 | `screen-tests/tabs-live.test.tsx` | **fixed** | `TAP_FLOOR_PT = 44` asserted against `Size.tapTarget` once, then every control measured against the floor rather than against the token itself; `mode-pill-general` still measured before `goLive()`. Width is explicitly **not** asserted, with the reason in the test: `installLayoutStub` answers one fixed `offsetWidth` for every node, so a width check would pass for a 4pt control. |
| F20 | `screen-tests/tabs-account.test.tsx` | **fixed** | `useHealth`/`useMe` are now state-driven and reset per test; added a failed-connection case (both hooks error → the card says so in words, and sign-out/delete stay reachable) and a loading case. |
| F21 | `testing/duotone.test.tsx` | **fixed** | Added the non-vacuity test for the raw `style`-attribute scan: a custom property jsdom drops from the computed view, with the premise (`computed .color === ink`) asserted before the guard is expected to throw. It is the only test in the file that fails if that scan is deleted. |
| F22 | `testing/layout-stub.ts` | **fixed** | `observe()` reports only the newly added target (was mapping over every target seen so far — O(k²) across a screen, and entries for nodes that did not resize), and builds a complete `ResizeObserverEntry` with `contentRect`/`contentBoxSize`/`borderBoxSize` instead of a `{ target }` cast. Verified `chamfer.tsx` and `scanlines.tsx` read only their own node. |

## Minor

| # | File | Verdict | Reason |
|---|---|---|---|
| F23 | plan doc | **fixed** | Both `apps/mobile/src/app/(app)/account.tsx` references → `(tabs)/account.tsx`. |
| F24 | `scripts/make_blink_patch.sh` | **fixed** | Real. `L, T, R, B` feed `Image.crop`, whose right/bottom are exclusive — so the seam report read `B`/`R`, one pixel outside the patch, and off the image entirely when the box reached full width or height. Now `B - 1` / `R - 1`, ranges unchanged. |
| F25 | `hooks/use-appearance.tsx` | **fixed** | Real. The restore is a round trip and the Account row is one tap away on the frame after mount, so a stored value could land on top of a pick and rewrite it in front of the user. A `chosen` ref guards it; test resolves storage after a cycle and asserts the pick stands. |
| F26 | `features/live-call/steer-pairing.test.ts` | **fixed** | The old discard test had an empty queue, so "s2 got no steer" was true for the trivial reason. Rewritten with two steers, a discard, and a third steer submitted before `s2` arrives — `s2` gets `second`, `s1` keeps `first`, `third` stays pending. |
| F27 | `features/notes/follow-up.test.ts` | **fixed** | `no_notes` is read off the meeting, not off a failed POST, so deriving the kind list from `mapFollowUpFailure` left the panel's most common empty state out of the copy check. Added explicitly, with a `toContain` guard so it cannot silently drop out again. |
| F28 | `features/live-call/capture-pane.tsx` | **fixed** | Comment claimed both panels stay mounted; the ternary mounts one. Rewritten to say the unread dot comes from `useLiveSession`'s `notes.hasUnseen`, which is why the hidden panel does not need to exist. No behaviour change. |
| F29 | `features/live-call/live-header.tsx` | **fixed** | `MODE_LABELS[mode].toUpperCase()` put the mono register into the accessible text. Now `textTransform: 'uppercase'` in style; the two rail assertions updated to `General`, one of them also pinning the transform. |
| F30 | `features/mascot/mascot-stage.test.tsx` | **fixed** | The stub dropped `tintColor` and `contentFit`. The tint is now painted as a background (sign-in's established pattern) and the duotone test reads the *tinted* layer instead of the first image it finds; `contentFit` is recorded by testID (React Native's `ViewProps` has no `dataSet`, so a data attribute would not typecheck) and the placement test pins `fill` on the patch against `contain` on the base. |
| F31 | `app/(app)/(tabs)/account.tsx` | **fixed** | `aria-disabled={busy}` on the cancel key, matching confirm. |
| F32 | `components/auth-form.tsx` | **fixed** | The error had no live region and the field state is a border weight, so a failed sign-in was silent to assistive tech. Added `accessibilityRole="alert"`, `accessibilityLiveRegion="assertive"` and `role="alert"` (native + web channels), styling untouched. |
| F33 | `features/meetings/format.ts` | **fixed** | **Real defect.** `today - 6 * 24 * 60 * 60 * 1000` is not six calendar days: across a DST change it lands at 01:00 or 23:00 on the boundary day, filing a call in that hour under the wrong heading. Replaced with `startOfLocalDaysAgo(now, 6)` in both `formatRelativeDay` and `groupMeetingsByRecency`, so both edges of the window are local midnight wherever it runs. |
| F34 | `features/notes/follow-up-panel.test.tsx` | **fixed** | Added the positive `follow-up-state` anchor, so a panel that rendered nothing at all no longer satisfies the absence check. |
| F35 | `features/meetings/meeting-card.test.tsx` | **fixed** | A `waitFor` on an absence passes on its first tick. Settles on `meeting-meta-<id>` and asserts the polygon's absence once. |
| F36 | `features/meetings/detail-tabs.tsx` | **fixed** | The comment claimed a `Record`-backed tuple; it was a plain array of three, which is a valid array however many members `DetailTab` has. Now `TAB_LABELS: Record<DetailTab, string>` + `TAB_ORDER`, the shape `capture-pane.tsx` already uses. |
| F37 | `features/stream/thinking-indicator.test.tsx` | **fixed** | The test only compared constants. `withTiming` is now a spy in `testing/reanimated-stub.ts` (same pass-through behaviour), and the test renders the indicator and asserts each `bar.sweepMs` reaches an animation — so a shared hardcoded duration fails. |
| F38 | `app/(app)/meetings/[id].tsx` | **fixed** | Real. The eyebrow says `‹ MEETINGS` but `router.back()` is a dead control on a deep link, notification tap or cold start. Now `canGoBack()` → `back()`, else `replace('/')`, on both render paths. Two tests. |
| F39 | `screen-tests/tabs-account.test.tsx` | **fixed** | Test renamed and commented as pinning the chip's SHAPE, not a verified plan tier — `/me` carries none (spec §10 wire workstream). |
| F40 | `screen-tests/meeting-detail.test.tsx` | **fixed** | Processing, failed and none all draw the same retry-less card, so the test passed on any of them. Now asserts `FOLLOW_UP_FAILURE_COPY.notes_not_ready`'s exact title and body. |
| F41 | `screen-tests/root-layout.test.tsx` | **fixed** | The old case was a restore, not a transition. Kept it (renamed) and added a real transition: render on `auto`/cobalt, flip the OS to light, re-render, and assert `contentStyle` and `navigationTheme` move together. |
| F42 | `screen-tests/tabs-live.test.tsx` | **fixed** | `shouldAdvanceTime` let the word cycle turn between reading `midWait` and asserting on it. Real time now covers `goLive()` only; the wait runs on a clock the test owns. |
| F43 | `screen-tests/sign-in.test.tsx` | **fixed** | The retry resolved immediately, so "clears at the START of the next attempt" and "clears on success" were indistinguishable. The next attempt is now held open and the absence asserted while it is still pending. |

## Trivial

| # | File | Verdict | Reason |
|---|---|---|---|
| F44 | `features/live-call/steer-pairing.ts` | **skipped** | `known`/`byId` are bounded by one call's suggestions (tens), and pruning `known` to the visible set would re-open the re-pairing hole the map exists to close — against a function the screen adjusts state off *during render*, where an identity slip is an infinite loop. Spec §10's wire upgrade deletes the module. |
| F45 | `features/notes/transcript.test.ts` | **skipped** | The module's documented contract IS uppercase pass-through, and the suite already pins `me`→`ME`, `them`→`THEM`, `Me`→`ME` and `spk_0`→`SPK_0`. A rename would obscure that ME/THEM are pinned. |
| F46 | `features/notes/transcript.ts` | **skipped** | The suggested code is behaviourally identical to `speaker.toUpperCase()` — a no-op refactor. The doc comment already explains why an unrecognised diarizer label is shown as given. |
| F47 | `features/notes/transcript-panel.tsx` | **fixed** | `useMemo` on the grouping and `useCallback` on `renderItem`, both above the early returns. Hundreds of turns re-grouped on every palette change, and a fresh `renderItem` costs the `FlatList` its row memoization. |
| F48 | `features/live-call/copilot-pane.test.ts` | **skipped** | Not testable from here: `onContentSizeChange` is fired by react-native-web's ScrollView from a layout jsdom does not have, `scrollToEnd` is a ref method with nothing to observe, and `placeholderFor` is module-private. Recorded for the next branch (it needs a seam, not a test). |
| F49 | `hooks/use-meeting-transcript.ts` | **skipped** | Controller ruling: sound refactor, deferred to the next branch to keep this PR's risk profile flat. Recorded for the next branch. |
| F50 | `hooks/use-meeting-transcript.test.ts` | **fixed** | `vi.useRealTimers()` moved into `afterEach` (a failed assertion skipped it and leaked fake timers into the rest of the file), and added the 404 case asserting "This meeting is no longer available." |
| F51 | `features/live-call/call-clock.test.ts` | **skipped** | Verified against the implementation: `if (fresh \|\| running) setElapsedMs(0)` zeroes on **every** false→true transition, and the effect re-reads the wall each time — so CodeRabbit's `toBeGreaterThanOrEqual(30_000)` contradicts the code. It also describes a state `useLiveSession` never produces: there is no `live → connecting → live` path (`use-live-session.ts` sets `connecting` only from `start()`). The suite's other three suggested cases already exist. |
| F52 | `app/(app)/meetings/[id].tsx` | **fixed** | New `NOTES_NOT_READY_TO_DRAFT_FROM`, built through `mapFollowUpFailure(409, 'notes_not_ready')`, so the read side stops quoting an HTTP status it never received. Equality test guards the two roads to that state. |
| F53 | `features/stream/drain.test.ts` | **fixed** | `afterEach(() => vi.useRealTimers())` on the describe block. |
| F54 | `testing/duotone.ts` | **fixed** | Comment added at the SVG branch's `continue`: react-native-svg emits `fill`/`stroke` as attributes (already read above), and jsdom reports CSS initial values for them on every SVG element — a black nothing painted. |
| F55 | `screen-tests/tabs-account.test.tsx` | **fixed** | Added the round-trip test: whatever the cycle wrote is what the next cold start is handed, rather than two independent literals that can drift apart with both tests green. |

---

## Scope notes

- **Nothing touched `apps/server` or `packages/shared`.** F18 required *reading*
  `packages/shared/src/live.ts` to confirm the `transcript.input` shape; no change was
  needed there.
- **StateCard adoption / visual-language unification** stayed out of scope per ruling;
  only the additive F11 test suite landed.
- Repo constraints held: TS strict, tokens-only styling, no test files under
  `apps/mobile/src/app/`, every file under the ~400-line soft cap.

## Deferred to the next branch

1. **F13** — extract `hasLoneSurrogate` / `stalledClock` / `manualClock` from
   `drain.test.ts` into a shared timer-test helper, reused by `blink-clock` and
   `mascot-glitch`.
2. **F49** — extract a `fetch-json.ts` (schema in, discriminated result out) shared by
   `use-meetings` and `use-meeting-transcript`, with the 404 copy, loading transition
   and silent-failure policy staying at the call sites. `use-meeting-notes` still lacks
   the timeout + `safeParse` those two have (spec §10 wire workstream).
3. **F48** — `copilot-pane`'s pin/auto-scroll needs a testable seam (the pin decision
   pulled out as a pure function) before a test can reach it; `placeholderFor` wants
   exporting.
4. **F51 follow-on, product question for Gustavo** — `useCallClock` zeroes on every
   `running` false→true transition. Today no code path produces one mid-call, so this
   is latent, not broken. If a reconnect is ever added to `useLiveSession`, the HUD
   clock will restart from `00:00` on a call that has been running for thirty minutes.
