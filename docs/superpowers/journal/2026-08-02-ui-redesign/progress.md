# SDD ledger — plan: docs/superpowers/plans/2026-08-02-nova-ui-redesign.md
# branch: dev-claude-ui-design (working copy — dedicated feature branch, no worktree per session convention)
# model policy: ONE agent at a time, Opus 5 for every role (Gustavo directive)
Task 1: complete (commits cdd7694..50b9f31, review clean)
Task 1: minor (deferred): fonts.ts imports useFonts from @expo-google-fonts/spline-sans — repoint to expo-font when T14 uninstalls the package
Task 1: minor (deferred): _layout.tsx:20 ragged comment wrap
Task 1: minor (deferred): react-native-svg web-build resolution under vitest/jsdom unexercised — T3's svg test may need a resolver tweak or mock
Task 1: note for T14: font loading lives in design/fonts.ts (useNovaFonts), NOT _layout.tsx
Task 2: complete (commit c003118) — duotone tokens.ts, 114 mobile tests green, typecheck + expo lint clean
Task 2: darkPalette/lightPalette are now cobaltPalette/paperPalette (ThemeName cobalt|paper); paletteFor unchanged in name/behaviour, keeps 'unspecified' in its union (RN useColorScheme returns it)
Task 2: tokens.ts carries a marked LEGACY block (glass/stroke/ink2/ink3/hot/shadow*, FontFamily.sans*, old FontSize keys) with DUOTONE values — each name dies with the screen that last uses it; T14 should assert the block is empty
Task 2: concern for T10/T13/T14 — src/constants/theme.ts + hooks/use-theme.ts + Themed* components are a SECOND, non-duotone palette still used by auth/account/live screens; delete in T14 with a zero-consumer grep
Task 2: expo-linear-gradient now has zero consumers — uninstall in T14 with the Spline Sans packages
Task 2: review — spec compliant, 1 Important (record dot invisible on focused tab: hot→ink collision), minors 2-8 deferred
Task 2: minor (deferred): status tones accent/hot visually identical on meeting card — T11 restores distinction in words (carry to T11 brief)
Task 2: minor (deferred): inkSoft/inkFaint opacities unasserted in tokens.test.ts
Task 2: minor (deferred): duotone guard rejects canvas-tinted values — future scrim token must widen it correctly, not weaken it
Task 2: minor (deferred): raised glass border invisible (glassHi==stroke) until glass consumers redrawn
Task 2: minor (deferred): SplineSansMono_400Regular + SplineSans_500Medium load with zero consumers — T14
Task 2: minor (deferred): FontSize.body 14.5→15 undisclosed by any test
Task 2: minor (deferred): docs/DESIGN/notes-ui.md §7.1 stale token table — branch-level docs cleanup
Task 2: note for T13: constants/theme.ts + use-theme + Themed* second palette still live on auth/account/live — dies in T10/T13
Task 2: fix round 1/5 (1 addressed, 0 open — record dot flip via recordDotColor helper; commits c003118..16af4d2)
Task 2: complete (commits 50b9f31..16af4d2, review clean after 1 fix round)
Task 2: minor (deferred): tab-bar-metrics.test surfaceUnderDot hardcodes glassHi (retires with LEGACY block)
Task 2: minor (deferred): "never matches surface" test case near-vacuous for unfocused (exact-value cases carry the guarantee)
Task 2: minor (deferred): usePulse trough (0.35) dims focused-tab dot to ~1.4:1 at dimmest instant — consider trough cap ~0.5 if record indicator tightens
Task 3: review — approved, 2 Important (config comment false premise; resolve.extensions repo-global unscoped/undocumented), fix round 1 dispatched
Task 3: minor (deferred): no test asserts fill/stroke/strokeWidth reach the polygon (two getAttribute assertions)
Task 3: minor (deferred): contentStyle prop is YAGNI — no consumer, no test (testID is fine, mirrors glass.tsx)
Task 3: minor (deferred): svg alias hardcodes react-native-svg/lib/module/index.js — breaks silently on upgrade; comment the failure mode
Task 3: minor (deferred): content padding uses unclamped cut vs clamped geometry (self-correcting; note only)
Task 3: minor (deferred): absoluteFill layer vs caller padding alignment — verify once on simulator (Yoga 3.x padding-edge semantics)
Task 3: note: chamfer brackets take stroke color (no separate ink prop) — focus = raise stroke to ink + brackets; screens tasks should follow this idiom
Task 3: fix round 1/5 (2 addressed, 0 open — comment-only correction; commits c79be9f..8a85a83)
Task 3: complete (commits 16af4d2..8a85a83, review clean after 1 fix round)
Task 3: minor (deferred): add a one-line repo test asserting every *.web.* source lives under apps/mobile (converts the documented hazard into a caught one) — good T14/final-review candidate
Task 3: minor (deferred): comment overstates "only way to scope" (resolveId plugin exists; trade-off argument sound regardless)
Task 4: review — 1 Important (RingOrbit reduced-motion = frozen arc not double ring; test blind to it), fix round 1 dispatched
Task 4: minor (deferred): withTiming/withRepeat stub discards args — ORBIT_DURATION_MS 1100 and (-1,false) unasserted; durationMs + Scanlines opacity props untested
Task 4: minor (deferred): Scanlines emits ~200 discrete Rects; svg <Pattern> would tile one cell (test pins the implementation — switch = test rewrite)
Task 4: minor (deferred): stale useId colon-stripping comment (React 19 ids have no colons)
Task 4: minor (deferred): useReducedMotion called twice per instance (hook + component)
Task 4: minor (deferred): RING_INSET comment says gap but is radius delta
Task 4: minor (deferred): decorative svg overlays not aria-hidden — decide ONCE for the whole design layer (chamfer has same shape); good final-review item
Task 4: note for T5+: Reanimated cannot render under vitest — reusable stub pattern lives in light-sweep.test.tsx; lift to src/testing/ at second use
Task 4: fix round 1/5 (1 addressed, 0 open — innerRing(dashed) factory + intent-pinning test; commits 5bccdf0..e688796)
Task 4: complete (commits 8a85a83..e688796, review clean after 1 fix round)
Task 4: minor (deferred): at-rest ring weights unmatched (outer 0.35, inner full) — simulator glance; balanced pair = same strokeOpacity in reduced branch
== MOVEMENT 1 (foundation) COMPLETE: T1-T4, commits cdd7694..e688796 ==
Task 5: complete (commits e688796..da2e979, review clean — approved first pass)
Task 5: minor (deferred): arm() re-stamps lastTickAt on the tick path — on device a 6-8ms onText cost runs drain ~30-40% under baseCps (catch-up masks); fix = from-idle flag
Task 5: minor (deferred): throwing onText stalls drain permanently (unguarded emit; try/finally would close)
Task 5: minor (deferred): onText doc says 1-3 chars/tick but clamp test proves up to 12 — T6 must not rely on the bound
Task 5: minor (deferred): drain.test.ts 521 lines vs soft cap (~400); natural split at the two describes; also verbatim block lacks afterEach useRealTimers
Task 5: minor (deferred): boundary-exact assertions (189, 12) have zero margin; wholeCharacters cut>=1 precondition undocumented; `as unknown as` in test helpers
Task 6: complete (commits da2e979..eb365d3) — StreamingText + the lifted Reanimated stub; 174 mobile tests green, typecheck + expo lint clean
Task 6: Reanimated stub now lives at apps/mobile/src/testing/reanimated-stub.ts (reanimatedStub() + reanimatedSpies); light-sweep.test.tsx refactored onto it — use it, do not re-copy the mock
Task 6: react-hooks/set-state-in-effect is an ERROR in this repo (eslint-config-expo) — prop-derived state must be adjusted during render, not in an effect; StreamingText is the worked example
Task 6: getComputedStyle CANNOT read font-family under RNW+jsdom (base class `font:` shorthand beats the generated class) — see declaredFontFamily() in streaming-text.test.tsx; lift it at second use
Task 6: minor (deferred): caret height is FontSize.body — a consumer overriding fontSize via `style` gets a mismatched caret; make it a prop if a screen needs that
Task 6: minor (deferred): no lineHeight token on the stream text — decide once at the screen layer
Task 6: simulator check owed: inline caret baseline alignment inside Text (may want a 1-2pt translateY), and that 900ms blink + ~60cps reads as writing
Task 6: review — 2 Important (caret leaves early on reduced flip-back; complete stale across stream change under reduced motion — one root cause: divergence handling below the reduced short-circuit), fix round 1 dispatched
Task 6: minor (deferred): triple-asterisk bold-italic leaks a literal * — comment the parser limit
Task 6: minor (deferred): CARET_HEIGHT frozen at FontSize.body vs style fontSize override — height prop with first consuming screen (T13)
Task 6: minor (deferred): style-prop reach + glyph color from `color` untested
Task 6: minor (deferred): caret not accessibility-hidden inside the Text run (VoiceOver may read it) — pairs with the T4 aria-hidden decide-once item
Task 6: minor (deferred): reanimatedStub returns Record<string,unknown> — type against the real module shape to catch key typos
Task 6: minor (deferred): declaredFontFamily helper resolves by document order — caveat travels if lifted to testing/
Task 6: fix round 1/5 (2 Important addressed, 0 open — divergence test hoisted above the reduced-motion branch; completion carry-over gated on text === seen.text; commit 128d008)
Task 6: note: in StreamingText's render-phase adjustment the ORDER of branches is load-bearing — "which stream is this?" must be asked before "is motion reduced?"; both review bugs came from that ordering
Task 6: fix round 1/5 (2 addressed, 0 open — carry gated on text===seen.text; divergence hoisted above reduced branch; commits eb365d3..128d008)
Task 6: complete (commits da2e979..128d008, review clean after 1 fix round)
Task 6: note: second inert mutation survivor documented (generation bump under reduced divergence) — expected if anyone mutation-tests that line
Task 7: complete (commits 128d008..9918b3c, review clean — approved first pass)
Task 7: note: plan's cadence assertions forced a 4-beat cycle (COMPOSING dwells 2 beats) — reviewer confirmed math at all boundaries; which-word-dwells was a free variable, pinned by implementer's extra tests; endorsed
Task 7: minor (deferred): the durationMs={bar.sweepMs} wire has NO component-touching test (stagger test reads a literal; withTiming stub discards duration — make it a spy to assert 1400/1780/1150)
Task 7: minor (deferred): bar composite brightness ~26% (0.10+0.18*0.90) + BAND_PEAK 0.9 on a 6pt bar — two knobs for the simulator eye
Task 7: minor (deferred): sweeps start in unison at mount (one frame), separate immediately — device-eye note
Task 7: minor (deferred): flick test uses toBeGreaterThan where toBe(n+1) available (strobe bug survives); COMPOSING dwell no-flick behavior unpinned
Task 7: minor (deferred): word style hand-rolls eyebrowStyle (spread-then-override pattern instead); key={bar.width}; StubResizeObserver duplicated 3rd time → @/testing/layout-stub.ts candidate
Task 7: note for T13: screen-reader policy for the cycling word is the PARENT's (accessibilityLiveRegion decision at wiring time)
== MOVEMENT 2 (the stream) COMPLETE: T5-T7, commits e688796..9918b3c ==
Task 8: review — approved, 2 Important (destructive experiment flow → fix round 1; consumer contract placement → closed via this ledger note + T9 dispatch)
Task 8: T9 CONSUMER CONTRACT (binding): eye-patch.png is a pixel-exact crop of eyes-closed at box (420,486,812,684) = 392x198. Overlay placement on a rendered base of width W: left=420*W/1254, top=486*W/1254, width=392*W/1254, height=198*W/1254 — i.e. left 33.493%, top 38.756%, width 31.260%, height 15.789%. Full-bleed placement reproduces the seam this task eliminated.
Task 8: note: patch alpha is fully opaque (min 255) — no ghost-through at full close; slight bang ghosting INSIDE the patch at mid-fade is inherent to the source pair (fast 140ms cross-fade hides it)
Task 8: minor (deferred): seam metric samples one side of each border (asymmetry undocumented)
Task 8: fix round 1/5 (1 Important + 2 folded minors addressed — pinned-box invariant, validation, LAYOUT contract; commits ab3aca4..2c545d7)
Task 8: complete (commits 9918b3c..2c545d7, review clean after 1 fix round)
Task 8: minor (deferred): header usage line :23 still says "re-cut the box" for an experiment invocation (behavior safe, wording stale); huge-digit values get one line of bash noise before die; PREVIEW_DIR-inside-repo litter footgun documented only
Task 9: review — 2 Important (shared-value write order vs its own comment; double-blink 180ms leaves 16ms open window), fix round 1 dispatched
Task 9: RULING: plan's 180ms double-offset was a plan bug — the ratified demo (~243ms) is the design authority per the plan's own spec-wins clause; fixed to 240ms
Task 9: minor (deferred): TearSlice evaluates glitchFrameAt twice (second needs slice.top only); per-frame cost note corrected (7 callers, not 6)
Task 9: minor (deferred): float constants (±5.5px, 6.5s) are the one unpinned spec numbers — one-line assertion available
Task 9: minor (deferred): image-assets.d.ts union needs a one-line consumer note (RN Image rejects string)
Task 9: minor (deferred): sparkles paint under the glow (incidental z-order); glow jitters WITH the figure (projector spill should arguably stay put) — simulator calls
Task 9: minor (deferred): reduced-motion sparkles stay at full presence (inside "no twinkle" gloss, outside literal "eyes-open + scanlines only") — Gustavo's call at simulator pass
Task 9: fix round 1/5 (2 addressed, 0 open — write order + 240ms offset, open-window test pins the design claim; commits 0b8169f..20f825b)
Task 9: complete (commits 2c545d7..20f825b, review clean after 1 fix round)
Task 9: minor (deferred): the new write-order comment's worked example doesn't compute at 240 (ordering is defensive at current constants; re-anchor the number per re-reviewer's suggested line)
Task 9: minor (deferred): open window 76ms vs demo's ~108ms (spec's 140ms close forces it) — device-look note; TRACK_TOP parks at 0.9 (harmless, opacity 0 there)
== MOVEMENT 3 (the mascot) COMPLETE: T8-T9, commits 9918b3c..20f825b ==
Task 10: review — approved, 3 Important: (1) auth column unscrollable w/ keyboard, (2) duotone guard coverage gaps (borders/gradients/stop-color/shadow) — both in fix round 1; (3) ACTIVE chip hardcoded, /me has no tier — PRODUCT DECISION FOR GUSTAVO (options: hide plan row until wire seam, or keep commented placeholder; a lapsed user currently sees ACTIVE)
Task 10: minor (deferred): usePalette subscribes all consumers to OS events even when pinned (key memo on resolved theme); duotone normaliseColor 6-digit-hex only; (app)/_layout auth-loading still ThemedView (first frame off-brand) — T13/T14; screen-title size divergence account 16 vs meetings legacy 30 — pin at T11; error copy under field-block not per-field; password autoComplete hints missing (confirm field new); eyebrowStyle spread vs assign inconsistency
Task 10: note for T11/T12/T13: use @/testing/safe-area-stub (safe-area-context unparseable under vitest); duotone guard is the §11 gate for screen tests
Task 10: note: spec §8 loading skeletons on Account NOT delivered (brief didn't ask; spec-vs-brief gap) — final review triage
Task 10: fix round 1/5 (2 addressed, 0 open — ScrollView + guard widened to all claimed surfaces, real MascotStage in guarded tree; commits 176d050..06511a2)
Task 10: complete (commits 20f825b..06511a2, review clean after 1 fix round)
Task 10: CARRY-FORWARD for T14: auth ScrollView needs iOS keyboard insets (automaticallyAdjustKeyboardInsets OR the KeyboardAvoidingView pattern live.tsx:83-85 already uses) — zero scroll range on SE-class iOS otherwise
Task 10: minor (deferred): duotone DOM breach probes don't isolate computed-style reads (style one probe via a <style> rule); asColor silently passes oklch/lab/color-mix/var; url() word-scan false-positive potential; border check ignores border-style
Task 11: review — 2 Important (status word at inkFaint 2.69:1 vs spec >=65% floor; index.tsx 489 lines vs cap) — fix round 1 dispatched
Task 11: minor (deferred): focus-refresh test proves grouping only (deleting useFocusEffect wiring stays green — needs clock advance + re-focus to guard)
Task 11: minor (deferred): RETRY NOTES copy reads as a control inside the card's a11y label — card-local Record<NotesStatus,string> fixes in-scope when T12 settles failure copy
Task 11: minor (deferred): detail navigation router.push('/meetings/<id>') unasserted in screen suite; START A SESSION a11y label includes the ◉ glyph; header monthCount can crowd in empty state (simulator)
Task 11: PRODUCT (for Gustavo, with the T10 plan-row item): START A SESSION routes to /live which is role-gated — a customer tapping it may land nowhere; account key parked in header until T14 moves nav to the tab bar
Task 11: note for T12: cardChips + formatWeekday orphaned in format.ts (claim or delete); jsdom reduce-motion=true absent matchMedia — mock useReducedMotion in screen suites
Task 11: fix round 1/5 (2 addressed, 0 open — status word to inkSoft w/ computed-style test both palettes; skeletons extracted, 489→392; commits d7e6e90..5a6de78)
Task 11: complete (commits 06511a2..5a6de78, review clean after 1 fix round)
Task 11: minor (deferred): loading-list duplicates the card surface constants (shared style object would make the no-shift promise structural); separator inkFaint between two inkSoft runs — simulator glance; index.tsx at 392 near cap, T14's key removal gives headroom
Task 12: review — 1 CRITICAL (follow-up tab falsehoods on loading/error/failed/none) + 4 Important (dead TRY AGAIN on failed notes; transcript error dead-end; new hook missing timeout + leaks ZodError; "Untitled call" false title) — fix round 1 dispatched
Task 12: PRODUCT (for Gustavo, joins plan-row + /live-gate items): Insights "coming soon" card DROPPED (spec §5 has no insights; undoes ratified 2026-07-28 decision) — restore or bless the drop
Task 12: WIRE WORKSTREAM notes (spec §10 list grows): notes read model lacks meeting title + started_at/duration (detail header degraded); mobile regenerate hook for failed notes (POST exists server-side); follow-up POST unwired (4/5 kinds unreachable)
Task 12: minor (deferred): signed-out transcript idles at spinner (route-guarded in practice); groupTranscriptBySpeaker recomputes per render (useMemo); quota/failed follow-up kinds lack panel render tests; detail-tabs no captured RED (module-resolve only)
Task 12: note: orphans cardChips/formatWeekday DELETED; failure copy settled at source ('Notes failed') — improves meeting-card a11y label composition
Task 12: fix round 1/5 (1 Critical + 4 Important addressed, 0 open; commits eb34b70..37750de)
Task 12: complete (commits 5a6de78..37750de, review clean after 1 fix round)
Task 12: WIRE WORKSTREAM (add): use-meeting-notes still lacks timeout + safeParse (same two hardenings the transcript hook got — its raw message renders on two panels now); refresh() gives no loading feedback on retry presses
Task 12: minor (deferred): "transcript tab still has every word" claim ships on two cards for calls whose capture may have failed; mapFollowUpFailure-never-returns-no_notes invariant lives only in a doc comment; signed-out follow-up error offers unmintable TRY AGAIN (route-guarded)
Task 13: review — 1 CRITICAL (quota state bricks the Live tab for the mount lifetime) + 3 Important (ThinkingIndicator remount at suggestion.start; ran latches per-mount → false ended state; capture tabs 28pt / END 36pt / mode pills 36pt under the 44pt floor) — fix round 1 dispatched
Task 13: PRODUCT (for Gustavo): live-notes tab KEPT re-skinned (spec §4 doesn't draw it; wiring lives in the untouchable hook); steer placeholder says "(optional)" while the bridge requires text — reword or wait for §10
Task 13: minor (deferred): empty-done answer thinks forever (aborted generation → bars on a finished card); SessionBanner/QuotaCard lack live regions; glyph labels inconsistent (START/END/HUD raw to screen readers); eyebrow copy deviates while thinking (◆ NOVA vs pinned label) + reflows at handoff; FlatList data identity unstable per render (useMemo + React.memo free win)
Task 13: note: ended-state links to '/' — hook exposes no meeting id (wire workstream: expose meeting id on session end)
Task 13: fix round 1/5 (1 Critical + 3 Important addressed, 0 open; commits 337bdd8..bdffef8)
Task 13: complete (commits 37750de..bdffef8, review clean after 1 fix round)
Task 13: WIRE WORKSTREAM (add): each refused quota retry mints a meetings row (reaper stamps ended_at — noise not corruption); quota view suppresses the WRITING NOTES handoff for quota-terminated calls (arguably correct, note)
Task 13: minor (deferred): flex:1+minHeight pins pill/RESPOND boxes at exactly 46 — large dynamic type may overrun the chamfer polygon (simulator); header END 36→46 and capture card +18pt layout deltas (simulator); quota+idle stack unscrolled — SE headroom ~100pt at default type, tightest screen at large type
Task 14: tab bar rebuilt in the duotone (opaque canvas slab + hairline, soft not chamfered — it is a container; tabs inside stay ink-filled when selected), labels ▤ MEETINGS / ◉ LIVE / ◌ ACCOUNT at monoBold/monoXs+1.5, glyphs kept OUT of the accessible name (accessibilityLabel = the plain word), unselected label inkSoft not inkFaint (spec §11 floor)
Task 14: app-tabs.test.tsx is NEW and stubs `expo-router/ui` — so the TabList child-ELEMENT scan (the reason the triggers are direct children of TabBar) is NOT covered; breaking it throws "Couldn't find any screens" at runtime with the suite green. Simulator/`expo start` check, documented in the suite header.
Task 14: account MOVED to (app)/(tabs)/account.tsx (+ its test); `/account` URLs unchanged (the (tabs) group is not in the path), so every existing router.push('/account') still resolves. It gained tabBarClearance + insets.top and lost SafeAreaView (the floating bar reserves no layout space — DELETE ACCOUNT would sit under it). Header account key + styles removed from (tabs)/index.tsx.
Task 14: LEGACY palette block DELETED and pinned empty — tokens.test.ts now asserts the key set is exactly the seven duotone names. FontFamily.sans* and the nine legacy FontSize keys gone with it. tab-bar-metrics.test.ts surfaceUnderDot glassHi→canvas.
Task 14: design/glass.tsx + glass.test.tsx DELETED (zero consumers after the bar rebuild). Uninstalled @expo-google-fonts/spline-sans, spline-sans-mono, expo-linear-gradient AND expo-glass-effect — the last is BEYOND the brief's three-package list, added because deleting glass.tsx in this same task left it at zero consumers (grep-proven).
Task 14: fonts.ts trap closed — `useFonts` was imported from @expo-google-fonts/spline-sans (every font package re-exports it), so the uninstall would have taken font loading with it. Now from expo-font.
Task 14: (app)/_layout.tsx gains animation:'fade' + animationDuration:200 (NOT reduced-motion gated — a cross-fade is the gentler answer, not the riskier one) and the waiting frame gains RingOrbit. New _layout.test.tsx pins both (navigator options are invisible to every other suite).
Task 14: carry-forwards paid — detail-tabs 36pt→46pt real box (T13's idiom: pill flex:1+minHeight, surface flex:1) with a 44pt-floor test; auth ScrollView automaticallyAdjustKeyboardInsets (iOS; NOT assertable under jsdom — react-native-web drops the prop, so it is comment-documented only); *.web.* invariant test at testing/web-extension.test.ts (verified RED by planting a stray under packages/shared).
Task 14: docs — CLAUDE.md gains a UI REDESIGN paragraph (duotone, control language, five screens + bar, glass era retired, the MVP steer-field bridge, the full wire-workstream list, simulator-not-done); docs/DESIGN/notes-ui.md §7 gains a SUPERSEDED banner pointing at the spec (§7.4-7.6 still hold).
Task 14: NOT DONE / for Gustavo: every simulator item the ledger accumulated (T3 padding-edge, T4 ring weights, T6 caret baseline, T7 bar brightness, T9 sparkle z-order, T13 large-dynamic-type overrun) plus the four PRODUCT decisions still open (ACTIVE chip with no tier on /me, START A SESSION → role-gated /live, dropped Insights card, "(optional)" steer placeholder). The tab bar's own new items: three mono labels at 8.5pt on an SE, and whether the opaque canvas slab reads as floating or as a docked rail.
Task 14: the Expo-template Themed* island (themed-text/themed-view/use-theme/constants/theme/ui/collapsible/hint-row/web-badge/external-link) is DEAD — grep proves it is consumed only by itself, no screen reaches it. NOT deleted (outside the brief's list, and it owns hooks/use-color-scheme.web.ts which vitest.config.mjs names by hand). One clean sweep for whoever wants it.

Task 15: complete — Meetings list refreshes on focus + polls while notes are writing (commits 3323228, db466ca). Review round 1: 3 Important (silent-failure wipes list / blip stops poll / interval unpinned) — all fixed and mutation-verified; re-review approve, no new findings.
Task 15: minor (deferred): superseded pull-to-refresh swallows its failure (review Minor 6)
Task 15: minor (deferred): sticky `silent` flag — token-rotation refetch after a pull can wipe the list on failure; pre-existing; one-line fix recorded in task-15-review.md (derive loudness instead of storing it) (review Minor 7)
Task 15: minor (deferred): review round-0 Minors 1-5 (focus-refetch floor, `settled` semantics, no AppState gate, `refreshing` stick on mid-pull sign-out) — see task-15-review.md
Task 15: device check owed (Gustavo): end call → meeting appears on Meetings with no pull; WRITING NOTES flips to NOTES READY within ~5s; no top spinner during background refreshes.

LANDING (2026-08-02): branch renamed dev-claude-ui-design → dev-nova-ui-design. Final-review fix wave complete (3f0794b splash, 4af69e1 backdrop, 152c4d8 labels, 8b824f7 a11y ruling + 2764f52 root-stack follow-on) — re-review APPROVE. CodeRabbit --base development: 55 findings, 42 fixed / 13 skipped with reasons across 6 commits (1c93904..6f93d12); batch report in coderabbit-batch-report.md. npm run check green 1292/0. Pushed; PR #11 open into development — awaiting Gustavo's merge.
NEXT BRANCH carries: customer START A SESSION decision (product), StateCard adoption on meetings list, motion.ts sweep, fetch-json + drain-helper DRY extractions, copilot-pane pin/auto-scroll test seam, useCallClock reconnect-zeroing (latent, product question), mascot asset downscale, app.json cleanup (splash-icon mark, name/slug), /me plan tier, T15 minors. Device check owed: cold-start splash handoff.
