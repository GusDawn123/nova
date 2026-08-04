# Final whole-branch review — Nova UI redesign (recovered from session transcript)

## Strengths

The token spine did what a token spine is supposed to do. `apps/mobile/src/design/tokens.ts` is genuinely the whole vocabulary — seven colour names, three families, one scale — and the LEGACY block isn't just empty, it's *pinned* empty by `tokens.test.ts`. Grepping every colour literal in `apps/mobile/src` turns up exactly three files: `tokens.ts` itself, `testing/duotone.ts`, and the dead Themed\* island. For a 16k-line, 14-task, 45-commit redesign that is a remarkable result.

`apps/mobile/src/testing/duotone.ts` is the best artifact on the branch. It reads six surface classes (text, background, four border sides, `background-image`, both shadow properties, SVG `fill`/`stroke`/`stop-color`, and the raw inline `style` attribute), it canonicalises notation so `#0002DA` and `rgba(0,2,218,1)` compare equal, and it is proven non-vacuous by breaching one surface per test. It runs in 18 test files. That is a design invariant with actual teeth, not a lint rule with a nice name.

The comment discipline holds across all 14 tasks, and — more unusually — the *load-bearing* comments are the ones that got written. `streaming-text.tsx:189-227` explains why "which stream is this?" must be asked before "is motion reduced?" (both of that task's review bugs came from that ordering). `drain.push` before `drain.end` is called out as order-dependent at `streaming-text.tsx:271`. `app-tabs.tsx:33-39` explains why the triggers must be direct children of `TabBar`, which is the one structural fact the new `app-tabs.test.tsx` can't cover. These are exactly the lines a future editor would otherwise break.

The state copy is honest in a way that's rare and consistent: no dead retry on `notes-failed` (with the reason — the read would redraw the same card), no invented "Untitled call", the meta line labelled `NOTES` rather than printed as a bare time it can't prove is the call's, and "the transcript survives the notes" repeated across four panels. `fonts.ts` closing the `useFonts`-imported-from-a-doomed-package trap is the kind of catch that only happens when someone is actually paying attention.

Suite health is good: 43 files, 437 tests, **17.9s**, and the diff contains **zero** `any`, `as any`, `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, or `TODO`. Prettier is clean across `apps/mobile/src`.

## Ledger Triage

**Must-fix-before-merge — one, and it is a ruling the ledger explicitly routed here:**

- **T4:** *"decorative svg overlays not aria-hidden — decide ONCE for the whole design layer (chamfer has same shape); good final-review item."* The ruling was never made. There is **zero** `aria-hidden` / `accessibilityElementsHidden` / `importantForAccessibility` in the entire shipped design layer. See Important #2.

**Simulator-pass (Gustavo's eye, none block merge):** every T3/T4/T6/T7/T9/T11/T13 item the ledger already routed there — chamfer padding-edge, at-rest ring weights, caret baseline inside `Text`, bar brightness and mount-unison, sparkle z-order and glow jitter, the 76ms blink open window, card separator, `monthCount` crowding, large-dynamic-type overrun of the 46pt pill boxes, SE headroom on the quota+idle stack — plus T14's own two (8.5pt mono labels on an SE; whether the opaque canvas slab reads as floating or docked).

One of these deserves promotion within that bucket: **T5's** *"`arm()` re-stamps `lastTickAt` on the tick path — on device a 6-8ms `onText` cost runs drain ~30-40% under `baseCps`."* Drain cadence *is* the teleprompter. A 60cps design running at 40cps on a real phone is the single most product-visible item on the simulator list. Time it against a stopwatch, not by feel.

**Genuinely fine as-is:**

- **T13 "empty-done answer thinks forever"** — I chased this to the server and it is **unreachable**. `conductor.ts:307-316` sends `suggestion.discard`/`no_response` rather than an empty `done`, and `conductor.test.ts:100-122` is a regression test pinning that exact contract ("if that guarantee is ever relaxed, this test fails"). All that's owed is a one-line comment in `answer-card.tsx` naming the cross-repo invariant the card leans on.
- T5's unguarded `onText` emit, boundary-exact assertions, `as unknown as` in test helpers; T2's unasserted `inkSoft`/`inkFaint` opacities (T14's exact-key-set test carries the shape); T6's triple-asterisk limit, `CARET_HEIGHT` prop, `reanimatedStub` typing; T8's seam-metric asymmetry and stale header wording; T9's unpinned float constants; T12's `useMemo` on `groupTranscriptBySpeaker` and the route-guarded signed-out spinner.
- **T3's "`contentStyle` prop is YAGNI"** is now a dead item — it has ~20 consumers.

**PRODUCT / WIRE lines:** the four PRODUCT decisions are Gustavo's and I've left them alone. One hides something merge-relevant — see Important #7. The WIRE WORKSTREAM list hides no blocker and is fully carried into `CLAUDE.md`.

## Issues

### Critical (Must Fix)

**None.** Nothing on this branch is broken or blocking. I'd rather say that than manufacture one.

### Important (Should Fix)

**1. The Expo splash survived the redesign — a third colour is the app's literal first frame.**

`apps/mobile/src/app/_layout.tsx:42` renders `&lt;AnimatedSplashOverlay /&gt;`, which on native (`components/animated-icon.tsx:141-147`) is a full-screen `StyleSheet.absoluteFill` at `zIndex: 1000` with:

```js
backgroundColor: '#208AEF',   // Expo template blue
```

...holding `@/assets/images/expo-logo.png`. Behind it, `app.json:29-34` configures the native launch screen as `"backgroundColor": "#208AEF"` with `splash-icon.png`.

This is the **only reachable third-colour path in shipped code** — I grepped every hex, `rgba()`, and named colour under `apps/mobile/src`; the sole other offenders are `constants/theme.ts` and `themed-text.tsx`, both provably inert. And it's the highest-traffic surface in the product: every cold start, on the platform that matters, before any Nova pixel renders. `(app)/_layout.tsx:29-31` says *"the first thing the user ever sees is the mark itself, doing the waiting"* — on native that sentence is false, and commit 906ae3c ("the first frame is the mark") landed without anyone checking upstream of it.

It's pre-existing rather than introduced, which is exactly why 14 task-scoped gates couldn't see it: no task owned the root layout's splash. Fix is small — repoint both to `BRAND_BLUE` and a Nova mark, or delete `AnimatedSplashOverlay` and let `expo-splash-screen` hand off straight to the in-brand `app-waiting` frame that already exists. (`AnimatedIcon` in the same file, with its `#3C9FFE`/`#0274DF` gradient, has zero consumers and can go with it.)

**2. The decorative-a11y ruling was deferred to this review and is still owed.**

`mascot-stage.tsx:350` renders each sparkle as a bare `&lt;Text&gt;✦&lt;/Text&gt;` — five of them (`SPARKLES`, lines 110-116). `MascotStage` appears on **sign-in, sign-up, and the meetings empty state**. VoiceOver reads five "✦" nodes before it reaches `NOVA` on the front door of the app. The stage carries `pointerEvents: 'none'`, which stops taps and does nothing at all for assistive tech.

The same gap runs through `chamfer.tsx`, `scanlines.tsx`, `ring-orbit.tsx`, `light-sweep.tsx`, and the caret in `streaming-text.tsx`. One ruling closes all of it: `accessibilityElementsHidden` + `importantForAccessibility="no-hide-descendants"` on every purely-decorative layer (RN maps these to `aria-hidden` under react-native-web, so the existing suites can assert it).

**3. The cross-fade may paint React Navigation's theme background between screens.**

`(app)/_layout.tsx:61` sets `contentStyle: { backgroundColor: 'transparent' }` with `animation: 'fade'`. Root `_layout.tsx:41` wraps the tree in `ThemeProvider value={theme === 'paper' ? DefaultTheme : DarkTheme}` — whose `colors.background` are `rgb(1,1,1)` and `rgb(242,242,242)`. Transparent screen content is precisely what lets that container colour show through at the fade's midpoint: cobalt would darken toward black, paper lighten toward grey, on every push.

The comment's stated reasoning is inverted — the risk it names ("an opaque default underneath would flash the platform's own background") argues *for* an opaque canvas, not against it. `{ backgroundColor: palette.canvas }` is strictly safer: the screens paint that colour anyway, so an opaque canvas can never differ from what's on top of it, while transparent can. `_layout.test.tsx:130` currently pins the riskier choice. Worth 30 seconds on the simulator before merge; the fix is one line and the layout already holds `palette`.

**4. Two state-card languages ship side by side.**

`features/meetings/state-card.tsx` is the branch's canonical "nothing here, and this is why" card — mono eyebrow at `inkFaint`, message in `bodySemibold`/`bodySm`, optional `RingOrbit`, chamfered outline action. Four consumers, 12 call sites.

The **meetings list** doesn't use it. `(tabs)/index.tsx:210-263` hand-rolls `SignedOutCard`/`ErrorCard` with a **display-font shouty title** (`FontFamily.displayMid`, `displaySm`, ls 2) and no eyebrow. So a failure on Meetings reads "COULD NOT LOAD YOUR CALLS" in Orbitron, and a failure one tap away on Detail reads "NOTES" in Space Mono over "These notes wouldn't load" in Inter. Same job, same app, two visual languages.

Cause is ordering, not carelessness: T11 built the list before T12 extracted `StateCard`, and no per-task gate could see across that boundary. `session-views.tsx` (`EndedSummary`, `QuotaCard`) is a third hand-rolled copy — visually identical to `StateCard`, so that one is duplication rather than drift, but it's the same root.

**5. The glyph-in-accessible-name pattern was ratified in T14 and left unapplied twice.**

`app-tabs.tsx:182-184` sets it out: *"The glyph is decoration: `◌ ACCOUNT` read literally is noise."* `steer-bar.tsx:105` and the detail back button follow it. Two do not:

- `(tabs)/index.tsx:183-198` — `◉ START A SESSION`, role `button`, no `accessibilityLabel`
- `session-views.tsx:63-79` — `◉ START SESSION`, same

Both are the primary call to action on their screen.

**6. `design/motion.ts` is the one design-layer file the redesign never opened.**

Its header is entirely about the deleted glass era — `GlassView`, "the opacity trap", `docs/DESIGN/notes-ui.md §7.1` (now banner-marked SUPERSEDED). Five exports have zero consumers: `useRiseIn`, `useCardIn`, `useDotWave`, `wordDelay`, and `useCaret` (whose only mention anywhere is a comment in `streaming-text.tsx` explaining why it *wasn't* used).

Worse than dead code: `useCardInTransformOnly` still drives the entrances in `meeting-card.tsx:98` and `notes-panel.tsx`. Its entire reason for existing was that an opacity ramp stops `GlassView` rendering. `glass.tsx` was deleted in T14. Those two surfaces now enter without a fade to dodge a hazard that no longer exists.

**7. The branch adds a new entry point into a route customers' navigator may not register.**

`(tabs)/index.tsx:117` — `router.push('/live')` from the empty state. This nav path is new (base `4264af6` had no `/live` push). `app-tabs.tsx:96` filters the Live `TabTrigger` out for non-internal roles, and that file's own header explains that `TabList` builds the navigator's screens from the trigger *elements*.

The ledger has this as PRODUCT ("a customer tapping it may land nowhere") and I'm not re-litigating the decision — but the reach changed. It's now the primary CTA on the first screen every new customer sees, since empty-state *is* the first-run state. Verify against a `customer`-role account before merge; if it dead-ends, gating the key behind `useRole` is a two-line change.

### Minor (Nice to Have)

- **`StubResizeObserver` is duplicated 4×, not 3** — `light-sweep.test.tsx:52`, `chamfer.test.tsx:24`, `thinking-indicator.test.tsx:56`, `mascot-stage.test.tsx:99`, all near-identical to the canonical `testing/layout-stub.ts:24`. The helper landed and got **15** consumers; these four design-layer files predate it and were never migrated.
- **Stale reference to a deleted file** — `streaming-text.tsx:114` cites `features/live-call/markdown-lite.tsx` as live; T13 deleted it. (`docs/DESIGN/notes-ui.md:116` too, though that file is banner-marked superseded.)
- **Mascot asset weight** — `eyes-open.png` is 1254×1254 / 1.2MB and is bundled, for a render at 120–220pt (~6.3MB decoded per instance). `eyes-closed.png` (1.2MB) and `raw/` (3.5MB) are build inputs for `make_blink_patch.sh` and reach no `require`. Downscaling the shipped frame to ~660px would cost nothing visible.
- **`vitest.config.mjs` comment is now stale** — it calls `hooks/use-color-scheme.web.ts` "live for anything that themes itself"; post-T14 the only thing that themes itself through it is the dead Themed\* island.
- **Title tracking drift** — `MEETINGS`/`ACCOUNT` ls 4, live-header `NOVA` ls 3, auth `NOVA` ls 8. Probably intentional; worth one glance.
- **`copilot-pane.tsx:124`** — `data={entries as CopilotEntry[]}` casts away `readonly`, and `copilotEntries(...)` is called inline in `live.tsx:180`, so `FlatList` gets a new array identity on every delta. Survivable, but it's the one hot path in the product.
- **`app.json` is still Expo template** — `"name": "mobile"`, `"slug": "mobile"`, template icons/favicon, Android adaptive-icon background `#E6F4FE`. Out of the spec's scope (§1 is five screens), but it travels with Important #1.

## Recommendations

1. **Before merge:** the a11y ruling (#2, ledger-assigned), the two missing `accessibilityLabel`s (#5), and the splash (#1 — at minimum `#208AEF` → `BRAND_BLUE`, since it's the redesign's central claim). All three are small and mechanical.
2. **One simulator glance, one line:** the cross-fade backdrop (#3). Flip `contentStyle` to `palette.canvas` if it bleeds.
3. **Verify then decide:** the customer `/live` path (#7).
4. **Fold into the next branch, not this one:** `StateCard` adoption on the meetings list (#4), the `motion.ts` sweep (#6), the four `StubResizeObserver` copies, and the Themed\* island — which I verified is *genuinely* inert (zero external imports across all ten modules) and does not block merge. One clean sweep can take all four; `#4` and `#6` are the two that rot fastest, because each new screen copies whichever pattern it lands next to.
5. **Docs:** `CLAUDE.md`'s UI paragraph is accurate and honest — including the "simulator verification is Gustavo's" caveat. Add the decorative-a11y ruling to it once made, since it's a design-layer rule every future component inherits.

**Spec coverage sweep (§2-§9, §11)** — §2, §3, §6, §9, §11 fully delivered. Three gaps beyond the ledger's known one:

- **§4's "last-session shortcut"** on the idle Live screen — not built, not ledgered anywhere. `IdlePanel` has mode pills and START SESSION only.
- **§7's "she appears in loading moments, error moments"** — she appears on sign-in and the empty state only. Both omissions look like correct design calls (`RingOrbit` owns non-live waits per §6; a 220pt mascot would break the loading list's no-shift promise) but they're undocumented deviations from a binding spec.
- **§8's Account loading skeletons** (the ledgered spec-vs-brief gap) — **triage: fine as-is.** Nothing on that screen loads. The email comes off the session synchronously, the plan chip is a static placeholder, and the only async content is two mono whispers that already say "checking server…" / "verifying identity…". The spec presumed an account fetch that doesn't exist. Bless the deviation in writing rather than building a skeleton for nothing.

## Assessment

**Ready to merge?** With fixes.

**Reasoning:** This is disciplined work — the duotone guarantee holds across every screen I could reach, the token spine collapsed to one real vocabulary, and 437 tests run clean in 18 seconds with no escape hatches anywhere in 16k lines. Nothing is broken. But three things need closing first: the a11y ruling the ledger explicitly routed to this review and that no one made, and the Expo splash — which is the one third-colour path still reachable in shipped code and happens to be the first frame of every cold start, directly contradicting both spec §11 and the branch's own "the first frame is the mark". The consistency drift (two state-card languages, `motion.ts` unswept) is real but is next-branch work, not merge-blocking.
---

# Re-review — fix wave `db466ca..8b824f7` (scoped to Important #1, #2, #3, #5)

Branch `dev-nova-ui-design`. Four commits, one per finding. Scope was held exactly:
#4, #6, #7 and every Minor are untouched, as instructed.

## Per-finding verdict

**#1 Expo splash third colour — FIXED.**
Took the stronger of the two options offered: deleted rather than repointed.
`AnimatedSplashOverlay` and its import are gone from `app/_layout.tsx`, along with
`animated-icon.tsx`, `animated-icon.web.tsx`, `animated-icon.module.css`,
`expo-logo.png` and `logo-glow.png`. `app.json` splash `backgroundColor` →
`#0002DA`. Verified independently: `git grep -iE "208AEF|3C9FFE|0274DF"` over all
tracked files returns **zero hits**, and no reference to `animated-icon` /
`AnimatedIcon` / `AnimatedSplashOverlay` / either image survives outside two
explanatory comments.

The `preventAutoHideAsync()` removal is correct and the reasoning is sound: the
overlay's `onLayout` was the app's only `SplashScreen.hideAsync()` caller (verified
— zero `hideAsync` references remain anywhere), so keeping the prevent call without
the overlay would have pinned the native splash up forever. Nothing else depended on
either. `useNovaFonts()` is deliberately ungated, so there is no font wait the
overlay was covering. The two stale comments the deletion created were both chased
down — `vitest.config.mjs`'s `.web.*` block and `web-extension.test.ts`'s
"two known files" note — and that guard still watches `use-color-scheme.web.ts` and
still passes. That is a level of follow-through I did not ask for and would not
have caught until the next review.

**#2 Decorative-a11y ruling — FIXED, and the deviation is correct.**
I checked the implementer's claim rather than taking it: react-native-web is
**0.21.2**, and `decorative.test.tsx`'s second case renders a `<View>` carrying
`accessibilityElementsHidden` + `importantForAccessibility` *without* the aria prop
and asserts no `aria-hidden` reaches the DOM. It passes. So my review's stated
mechanism ("RN maps these to `aria-hidden` under react-native-web") was wrong, the
implementer's three-prop set is right, and the native pair still ships for iOS and
Android — which is what I actually cared about. Better still, that test is written
to **fail** the day rn-web starts forwarding, which is the day the aria prop stops
being load-bearing. The deviation improved on the prescription.

Applied at all six sites, each on the highest wholly-decorative container. The one
that mattered — `chamfer.tsx` — hides only the `absoluteFill` SVG **layer**, never
the surface or its `children`, so no control in the app lost its accessible name;
`chamfer.test.tsx` asserts both halves. `mascot-stage.tsx` hides the whole stage
with the five `✦` inside it, and `tabs-index.test.tsx` proves it on the real mascot
in the first-run empty state while `NO CALLS YET` stays in the reading order. Seven
new assertions, all non-vacuous.

**#3 Cross-fade backdrop — FIXED.**
`(app)/_layout.tsx` `contentStyle` → `{ backgroundColor: palette.canvas }`, comment
rewritten with the un-inverted reasoning, and `app-layout.test.tsx` now pins
`cobaltPalette.canvas` instead of `'transparent'`. I confirmed the numbers the fix
is defending against: `expo-router`'s `DarkTheme.colors.background` is
`rgb(1, 1, 1)` and `DefaultTheme.colors.background` is `rgb(242, 242, 242)`.

**#5 Missing `accessibilityLabel`s — FIXED.**
`"Start a session"` and `"Start session"` — words only, no glyph, each with a
comment pointing at the `app-tabs.tsx` precedent. Both new assertions use
`getByLabelText(...)` **identity-checked against the `start-session-key` node**, so
the label cannot silently drift onto a different element. That is the right shape.

## New Critical / Important introduced

**One Important — a direct consequence of the #1 deletion.**

**The root `Stack` still paints React Navigation's stock background, and nothing
covers it any more.** `app/_layout.tsx`'s `<Stack screenOptions={{ headerShown:
false }} />` carries no `contentStyle`, so its screen containers default to
`theme.colors.background` — `rgb(1, 1, 1)` under `DarkTheme` (cobalt),
`rgb(242, 242, 242)` under `DefaultTheme` (paper). Until this wave,
`AnimatedSplashOverlay` sat over that at `zIndex: 1000` for the whole cold-start
handoff. It no longer does, so the window between the native splash auto-hiding and
`(app)`/`(auth)` painting its canvas is now backed by near-black on cobalt and
near-white on paper. The same root stack also carries every `(auth)` ↔ `(app)`
transition (sign-in success, sign-out) over that backdrop.

This is exactly the defect #3 just closed, one level up — the fix landed on the
inner stack and the root was left as it was. Not introduced by the fix so much as
*uncovered* by it, but uncovered is reachable. The fix is the same one line:
`ThemedStack` already calls `useAppearance()`, so `palette` is one destructure away,
and it can take `contentStyle: { backgroundColor: palette.canvas }` on the root
`Stack` (and, if you want belt and braces, a navigation theme whose
`colors.background` is the canvas rather than stock). It folds into the same
cold-start simulator pass the implementer already owes under their Concern #1 — and
if a flash does appear there, this is the mechanism, not `preventAutoHideAsync`.

Nothing else. The other three fixes introduce no new defect I can find: the
decorative spread touches no wrapper holding content, the `contentStyle` flip is
strictly safer than what it replaced, and the two labels are additive.

## Verification run

`npx vitest run` over the 12 affected files: **142 passed / 0 failed** in 6.3s,
including the new `decorative.test.tsx`. Consistent with the implementer's reported
full `npm run check` (1262 passed / 210 skipped / 0 failed).

## Their five concerns, judged

1. **Splash is simulator-only** — agreed, and see the new Important above for the
   mechanism most likely to bite there.
2. **#3 still wants the simulator glance** — agreed, unchanged.
3. **`splash-icon.png` is still the Expo template mark on brand blue** — correct
   call to leave it; it belongs with the `name`/`slug`/icon Minor.
4. **`RingOrbit` now silent everywhere** — the right trade today (every site pairs
   it with words), and the concern is worth exactly the line they gave it.
5. **`AnimatedIcon` assets gone** — fine, git history has them.

## Final verdict

**Approve**, with the one-line root-stack `contentStyle` as a follow-on — it is the
tail of #3 rather than new work, and it is cheaper to add now, before the cold-start
simulator pass, than to discover during it. All four findings I raised are genuinely
closed, the one deviation from my prescription was verified rather than asserted and
was better than what I asked for, and the collateral cleanup (stale vitest and
web-extension comments) went beyond the brief.
