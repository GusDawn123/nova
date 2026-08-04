# CodeRabbit findings — dev-nova-ui-design vs development (2026-08-02)

55 findings. Each carries CodeRabbit's own instruction: verify against current code, fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, validate.

## F1 [major] scripts/strip_mascot_bg.sh

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @scripts/strip_mascot_bg.sh around lines 18 - 22, Update both chroma color examples in the usage comments for the script to use #0103D5 instead of #2733E6, including the examples around the script’s usage section and the corresponding later example.

## F2 [major] docs/superpowers/plans/2026-08-02-nova-ui-redesign.md

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @docs/superpowers/plans/2026-08-02-nova-ui-redesign.md around lines 472 - 475, Update the MVP RESPOND behavior and its session API integration so an empty steer submits the action for the latest transcript turn instead of disabling RESPOND. Preserve the existing sendInput(steer) path for non-empty steers, and extend the planned FakeSocket tests to verify empty-field RESPOND dispatches correctly.

## F3 [major] apps/mobile/src/design/chamfer.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/design/chamfer.tsx around lines 48 - 50, Update the content View padding in chamferPoints and bracketPoints to use the same clampCut(w, h, cut) value used for drawing, rather than the raw cut prop, so the inset matches the actual diagonal size on small surfaces.

## F4 [major] apps/mobile/src/hooks/use-appearance.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/hooks/use-appearance.tsx around lines 57 - 60, Update parseChoice to validate the AsyncStorage value through a Zod schema built from the existing APPEARANCE_ORDER enum, returning the parsed AppearanceChoice for valid values and null for invalid or absent values. Remove the hand-rolled APPEARANCE_ORDER.find validation while preserving the current fallback behavior.

Suggested code:

```
const choiceSchema = z.enum(APPEARANCE_ORDER);

/** Anything else under the storage key is no preference — not a crash, not a blank. */
function parseChoice(stored: string | null): AppearanceChoice | null {
  const parsed = choiceSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}
```

## F5 [major] apps/mobile/src/testing/router-directory.test.ts

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/testing/router-directory.test.ts around lines 28 - 32, Extract the duplicated repoRoot() helper from router-directory.test.ts and web-extension.test.ts into a shared testing utility, such as repo-root.ts, preserving its current Git-based behavior and exported API. Update both tests to import and reuse the shared repoRoot symbol, removing their local implementations.

## F6 [major] apps/mobile/src/app/(app)/(tabs)/live.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/app/(app)/(tabs)/live.tsx around lines 161 - 166, Update the LiveHeader usage and its HUD label logic to use the resolved cockpit view or clock.ran instead of raw live.status alone. Ensure a closed session with clock.ran false displays STANDBY, while sessions that actually ran retain the ENDED label.

## F7 [major] apps/mobile/src/components/app-tabs.test.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/components/app-tabs.test.tsx around lines 217 - 243, Update the two record-dot color tests in the AppTabs test suite to stop using recordDotColor as the expected oracle. Read the rendered tab/bar surface color from the DOM, assert the focused and unfocused dot colors against the appropriate literal design tokens, and verify each dot color contrasts with the surface it is painted over.

Suggested code:

```
describe('AppTabs — the record dot', () => {
  it('rides the Live tab and nothing else', () => {
    render(<AppTabs />);

    expect(screen.getAllByTestId('record-dot')).toHaveLength(1);
    expect(screen.getByTestId('tab-live')).toContainElement(
      screen.getByTestId('record-dot'),
    );
  });

  it('flips colour with focus, so it never vanishes into what it sits on', () => {
    focusedTab.name = 'live';
    render(<AppTabs />);

    // The focused pill is filled with ink; the dot must not be that ink.
    expect(normaliseColor(styleOf('record-dot').backgroundColor)).not.toBe(
      normaliseColor(styleOf('tab-live').backgroundColor),
    );
    expect(normaliseColor(styleOf('record-dot').backgroundColor)).toBe(
      normaliseColor(cobaltPalette.onInk),
    );
  });

  it('takes full ink on the unfocused tab, against the bar canvas', () => {
    render(<AppTabs />);

    // The unfocused pill has no fill, so the surface is the bar's own slab.
    expect(normaliseColor(styleOf('record-dot').backgroundColor)).not.toBe(
      normaliseColor(styleOf('tab-bar').backgroundColor),
    );
    expect(normaliseColor(styleOf('record-dot').backgroundColor)).toBe(
      normaliseColor(cobaltPalette.ink),
    );
  });
});
```

## F8 [major] apps/mobile/src/components/app-tabs.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/components/app-tabs.tsx around lines 142 - 146, Centralize the tab-bar float offset in tab-bar-metrics.ts by exporting its existing floatOffset value, then import and use that shared symbol for the bottom style in the app-tabs component so it stays consistent with tabBarClearance. Also derive TAB_BAR_HEIGHT from the existing height, tap-target, and padding design tokens instead of duplicating the geometry arithmetic, while preserving the current layout behavior.

## F9 [major] apps/mobile/src/app/(auth)/sign-in.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/app/(auth)/sign-in.tsx around lines 19 - 27, Update the footer Pressable in the sign-in screen to reserve the standard Size.tapTarget minimum height and center its content, matching the touch-target convention used by the other interactive styles while keeping the existing link text styling unchanged.

Suggested code:

```
      footer={
        <Link href="/sign-up" asChild>
          <Pressable accessibilityRole="link">
            <Text
              style={[
                styles.link,
                { color: palette.inkSoft },
              ]}
            >
              NEED AN ACCOUNT? SIGN UP
            </Text>
          </Pressable>
        </Link>
      }
```

## F10 [major] apps/mobile/src/app/(app)/meetings/[id].tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/app/(app)/meetings/[id].tsx around lines 241 - 252, Add Size to the token import and update the styles.back definition used by the back-button Pressable to include minHeight: Size.tapTarget, ensuring the control has the required 44pt real box height while preserving its existing padding and styling.

## F11 [major] apps/mobile/src/features/meetings/state-card.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/features/meetings/state-card.tsx around lines 45 - 89, Add a co-located state-card.test.tsx suite for StateCard, following the patterns used by detail-tabs.test.tsx, loading-list.test.tsx, meeting-card.test.tsx, and follow-up-panel.test.tsx. Cover that an undefined action omits the button, waiting controls RingOrbit and does not show it for failure-style states, and both palettes satisfy the expectDuotoneOnly contract for ChamferSurface and RingOrbit.

## F12 [major] apps/mobile/src/features/meetings/format.test.ts

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/features/meetings/format.test.ts around lines 72 - 84, Add boundary tests in the formatRelativeDay suite using the existing now fixture: assert July 16, 2026 (six days before now) returns its weekday, and July 15, 2026 (seven days before now) returns a formatted date. Keep the existing locale and expected-output conventions so the tests fail if the seven-day window changes.

Suggested code:

```
  it('names a day inside the last week by its weekday', () => {
    // 'en-US' pinned: the runner's default locale is not the user's, and an
    // unpinned assertion would pass or fail on the machine rather than the code.
    expect(
      formatRelativeDay(new Date(2026, 6, 20, 9).toISOString(), now, 'en-US'),
    ).toBe('Mon');
  });

  it('falls back to a date for anything older', () => {
    expect(
      formatRelativeDay(new Date(2026, 5, 2, 9).toISOString(), now, 'en-US'),
    ).toBe('Jun 2');
  });

  it('holds the weekday to the sixth day back, and no further', () => {
    // The rolling window's two edges. Without this pair the width of the
    // window is unconstrained and an off-by-one is invisible.
    expect(
      formatRelativeDay(new Date(2026, 6, 16, 9).toISOString(), now, 'en-US'),
    ).toBe('Thu');
    expect(
      formatRelativeDay(new Date(2026, 6, 15, 9).toISOString(), now, 'en-US'),
    ).toBe('Jul 15');
  });
```

## F13 [major] apps/mobile/src/features/stream/drain.test.ts

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/features/stream/drain.test.ts around lines 446 - 521, Extract hasLoneSurrogate, stalledClock, and manualClock from drain.test.ts into a shared testing helper module, then import and reuse them in drain.test.ts and the related blink-clock.ts and mascot-glitch.ts timer tests. Remove the local helper implementations and preserve their existing behavior and types.

## F14 [major] apps/mobile/src/features/stream/drain.test.ts

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/features/stream/drain.test.ts around lines 356 - 368, Update the test around createStreamDrain so onText only collects emitted chunks, then assert hasLoneSurrogate is false after draining completes for the collected chunks and their joined value. Also require chunks.length > 1 before validating the surrogate property, ensuring the emoji text was actually split across multiple emissions.

Suggested code:

```
    const chunks: string[] = [];
    const d = createStreamDrain({
      onText: (c) => chunks.push(c),
      onDone: () => {},
    });

    d.push(text);
    vi.advanceTimersByTime(5000);

    expect(chunks.length).toBeGreaterThan(1); // the text really was split
    for (const chunk of chunks) {
      expect(hasLoneSurrogate(chunk)).toBe(false);
    }
    expect(chunks.join('')).toBe(text);
```

## F15 [major] apps/mobile/src/testing/duotone.ts

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/testing/duotone.ts around lines 105 - 129, Update asColor to pass NAMED_CANONICAL values through normaliseColor instead of returning the raw hex string, so white/black use the same canonical representation as palette values. Add a duotone.test.tsx case under “what it lets through” using the palette member corresponding to #ffffff, confirming the named white spelling passes.

## F16 [major] apps/mobile/src/screen-tests/tabs-index.test.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/screen-tests/tabs-index.test.tsx around lines 41 - 55, Extend the test around the screen render at the existing tab test block to advance or mock Date.now across a simulated refocus, then assert the Today/Earlier grouping updates after that refocus. Use the expo-router useFocusEffect mock’s callback-driven behavior rather than relying only on initial mount, and verify the test fails if the screen stops re-reading the clock on focus.

## F17 [major] apps/mobile/src/screen-tests/sign-up.test.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/screen-tests/sign-up.test.tsx around lines 19 - 23, Update sign-up.test.tsx to mirror sign-in.test.tsx’s realMascot arrangement: add the real mascot flag, reset it in the existing beforeEach, and enable it for the duotone case before calling expectDuotoneOnly. Replace the always-active MascotStage stub behavior so the guarded render includes the mascot layers, and add the @/design/motion and expo-image mocks needed for those layers to render and expose tinting.

## F18 [major] apps/mobile/src/screen-tests/tabs-live.test.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/screen-tests/tabs-live.test.tsx around lines 197 - 213, Update the outbound transcript.input assertion in the test to require v: LIVE_PROTOCOL_VERSION and the session identifier when that field is required by the transcript.input schema, using SESSION_ID as its expected value. Keep the existing type, text, and origin assertions, and confirm the shared live schema before adding session_id.

Suggested code:

```
  it('sends the steer up the existing wire and chips it above the answer', async () => {
    render(<LiveScreen />);
    const socket = await goLive();

    respond('push on the timeline');

    expect(socket.frame('transcript.input')).toMatchObject({
      v: LIVE_PROTOCOL_VERSION,
      type: 'transcript.input',
      text: 'push on the timeline',
      origin: 'utterance',
    });
    expect(screen.getByTestId('steer-chip')).toHaveTextContent(
      'push on the timeline',
    );
    // She is thinking before a single token has landed.
    expect(screen.getByTestId('answer-thinking')).toBeInTheDocument();
  });
```

## F19 [major] apps/mobile/src/screen-tests/tabs-live.test.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/screen-tests/tabs-live.test.tsx around lines 393 - 410, Update the tap-target test around LiveScreen and the controls identified by mode-pill-general, end-session-key, capture-tab-notes, and respond-key: assert Size.tapTarget is at least the platform floor once, then measure both width and height of each control against that token. Keep the mode-pill-general measurement before goLive(), use TAP_FLOOR_PT rather than comparing the token to itself, and use the layout stub’s offsetWidth when minWidth is absent; only omit its width check with an explicit reason if necessary.

## F20 [major] apps/mobile/src/screen-tests/tabs-account.test.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/screen-tests/tabs-account.test.tsx around lines 63 - 72, Make the useHealth and useMe mocks state-driven rather than permanently returning success, exposing mutable test values for each hook and resetting the me value in beforeEach. Add an Account screen test covering a failed useMe or useHealth response, asserting the screen’s expected error behavior instead of silently rendering an empty tree; retain the existing loaded-state coverage.

## F21 [major] apps/mobile/src/testing/duotone.test.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/testing/duotone.test.tsx around lines 94 - 169, Add a test in the expectDuotoneOnly suite that exercises the raw inline style path scanned by duotone.ts, using a custom property or unsupported CSS function that this jsdom version drops from computed styles. Assert the computed-style guard does not detect the color while the full guard still throws, proving the breach is visible only through the raw style attribute.

Suggested code:

```
describe('expectDuotoneOnly — what it catches', () => {
  it('an off-palette text colour', () => {
    expect(guard(<div style={{ color: OFF_PALETTE }}>error</div>)).toThrow(OFF_MATCH);
  });

  it('an off-palette background', () => {
    expect(guard(<div style={{ backgroundColor: OFF_PALETTE }} />)).toThrow(OFF_MATCH);
  });

  it('an off-palette border on ANY side, not just the top', () => {
    // The reason all four sides are read: an accent stripe down one edge is the
    // most natural way to sneak a second colour into a card.
    for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
      expect(
        guard(
          <div
            style={{
              [`border${side}Width`]: 3,
              [`border${side}Style`]: 'solid',
              [`border${side}Color`]: OFF_PALETTE,
            }}
          />,
        ),
        `border ${side}`,
      ).toThrow(OFF_MATCH);
    }
  });

  it('an off-palette gradient stop', () => {
    // Spec §2 permits gradients as light sweeps — it does not permit their stops to
    // be any colour they like.
    expect(
      guard(
        <div
          style={{
            backgroundImage: `linear-gradient(180deg, ${INK} 0%, ${OFF_PALETTE} 100%)`,
          }}
        />,
      ),
    ).toThrow(OFF_MATCH);
  });

  it('an off-palette SVG gradient stop', () => {
    // This is the mascot's glow and the tear track: the colour is on the stop, not
    // on any fill or stroke attribute.
    expect(
      guard(
        <svg>
          <defs>
            <radialGradient id="probe-bad">
              <stop offset="0" stopColor={OFF_PALETTE} />
            </radialGradient>
          </defs>
          <circle cx={5} cy={5} r={5} fill="url(#probe-bad)" />
        </svg>,
      ),
    ).toThrow(OFF_MATCH);
  });

  it('an off-palette svg fill or stroke', () => {
    expect(guard(<svg><rect fill={OFF_PALETTE} /></svg>)).toThrow(OFF_MATCH);
    expect(guard(<svg><rect stroke={OFF_PALETTE} /></svg>)).toThrow(OFF_MATCH);
  });

  it('an off-palette shadow', () => {
    expect(guard(<div style={{ boxShadow: `0 2px 8px ${OFF_PALETTE}` }} />)).toThrow(OFF_MATCH);
    expect(
      guard(<div style={{ textShadow: `0 1px 2px ${OFF_PALETTE}` }}>glow</div>),
    ).toThrow(OFF_MATCH);
  });

  it('a colour that hides behind its name', () => {
    // `crimson` is no more allowed than `#dc143c`, and a grep for hexes would miss it.
    expect(guard(<div style={{ color: 'crimson' }}>named</div>)).toThrow(/crimson/i);
  });

  it('a colour jsdom refuses to parse into the computed view', () => {
    // The reason `duotone.ts` reads the raw `style` attribute at all: jsdom drops
    // values its CSS parser rejects, so the computed view reports nothing and every
    // other surface in this file goes quiet. This is the ONLY test that fails if
    // that scan is deleted.
    const { container } = render(<div data-testid="probe" />);
    const probe = container.querySelector('[data-testid="probe"]');
    if (probe === null) throw new Error('the probe never rendered');
    probe.setAttribute('style', `--nova-accent: ${OFF_PALETTE}; color: ${INK}`);

    // Prove the premise before asserting on it: the computed view must be blind here.
    expect(normaliseColor(getComputedStyle(probe).color)).toBe(normaliseColor(INK));

    expect(() => {
      expectDuotoneOnly(container, cobaltPalette);
    }).toThrow(OFF_MATCH);
  });
});
```

## F22 [major] apps/mobile/src/testing/layout-stub.ts

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/testing/layout-stub.ts around lines 24 - 44, Update StubResizeObserver.observe to notify only the newly added target rather than mapping over all targets, preserving O(k) behavior across sequential observations. Build a complete, runtime-valid ResizeObserverEntry for that target, including contentRect, contentBoxSize, and borderBoxSize, without using an unsafe partial-object cast; verify design/chamfer.tsx and design/scanlines.tsx do not rely on re-reporting previously observed targets.

Suggested code:

```
function entryFor(target: Element): ResizeObserverEntry {
  const width = (target as HTMLElement).offsetWidth;
  const height = (target as HTMLElement).offsetHeight;
  const rect = { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height };
  return {
    target,
    contentRect: { ...rect, toJSON: () => rect } as DOMRectReadOnly,
    borderBoxSize: [{ inlineSize: width, blockSize: height }],
    contentBoxSize: [{ inlineSize: width, blockSize: height }],
    devicePixelContentBoxSize: [{ inlineSize: width, blockSize: height }],
  };
}

class StubResizeObserver implements ResizeObserver {
  private readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element): void {
    if (this.targets.has(target)) return;
    this.targets.add(target);
    // Only the new target, as a real observer reports it — and with a rect, so a
    // consumer that reads `contentRect` gets a number rather than a crash.
    this.callback([entryFor(target)], this);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
  }
}
```

## F23 [minor] docs/superpowers/plans/2026-08-02-nova-ui-redesign.md

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @docs/superpowers/plans/2026-08-02-nova-ui-redesign.md around lines 45 - 48, Update the plan’s Account screen references from apps/mobile/src/app/(app)/account.tsx to apps/mobile/src/app/(app)/(tabs)/account.tsx, including the entries around the listed presentation routes and related task text. Ensure the documentation targets the currently rendered Account tab route and does not retain outdated path references.

## F24 [minor] scripts/make_blink_patch.sh

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @scripts/make_blink_patch.sh around lines 173 - 180, Update the border point construction in the reporting loop to treat the exclusive crop bounds B and R as one-past-the-edge: use B - 1 and R - 1 for the bottom and right pixel coordinates, while preserving the existing range behavior for the top, bottom, left, and right edges and preventing out-of-bounds access when the box reaches image dimensions.

Suggested code:

```
for name, pts in (
    ("top", [(x, T) for x in range(L, R)]),
    ("bottom", [(x, B - 1) for x in range(L, R)]),
    ("left", [(L, y) for y in range(T, B)]),
    ("right", [(R - 1, y) for y in range(T, B)]),
):
    v = [delta[x, y] for x, y in pts]
    print(f"    SEAM {name:<6} {sum(1 for i in v if i > 40):>4}/{len(v)} px differ, max delta {max(v)}")
```

## F25 [minor] apps/mobile/src/hooks/use-appearance.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/hooks/use-appearance.tsx around lines 93 - 120, Guard the async restore in the appearance provider so a user selection made before AsyncStorage resolves cannot be overwritten; track whether setChoice has been called and skip applying the stored value when it has. Add a use-appearance.test.tsx case with deferred getItem resolution that selects a choice before resolving storage, then verifies the user’s choice remains active.

Suggested code:

```
  const chosen = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function restore(): Promise<void> {
      try {
        const stored = parseChoice(await AsyncStorage.getItem(APPEARANCE_STORAGE_KEY));
        if (stored !== null && !cancelled && !chosen.current) {
          setChoiceState(stored);
        }
      } catch {
        // A storage that will not answer (web static render, a wiped store) leaves
        // the default standing. An unreadable preference is not worth a broken app.
      }
    }

    void restore();

    return () => {
      cancelled = true;
    };
  }, []);

  const setChoice = useCallback((next: AppearanceChoice) => {
    chosen.current = true;
    setChoiceState(next);
    // Fire and forget: the pick is already applied on screen, and a failed write
    // costs the user the preference on next launch, not this tap.
    void AsyncStorage.setItem(APPEARANCE_STORAGE_KEY, next).catch(() => undefined);
  }, []);
```

## F26 [minor] apps/mobile/src/features/live-call/steer-pairing.test.ts

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/features/live-call/steer-pairing.test.ts around lines 79 - 88, Rewrite the test around steerSubmitted and pairSteerArrivals to submit two steers, pair the first with s1, discard s1 from the arrivals, then submit a third steer before s2 arrives. Assert that s2 receives the third steer, proving the discarded s1 entry is evicted from byId/known and that the test fails if stale discard handling regresses.

## F27 [minor] apps/mobile/src/features/notes/follow-up.test.ts

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/features/notes/follow-up.test.ts around lines 77 - 90, Extend the test around FOLLOW_UP_FAILURE_COPY to explicitly include the read-side no_notes kind in the kinds under validation, rather than deriving kinds only from mapFollowUpFailure results. Keep the existing mapped failure coverage and ensure no_notes also has nonempty title and body copy.

## F28 [minor] apps/mobile/src/features/live-call/capture-pane.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/features/live-call/capture-pane.tsx around lines 28 - 30, Correct the comment near the panel rendering in the capture-pane component to state that the hidden LiveNotesPanel is unmounted and unread state is maintained by useLiveSession via notes.hasUnseen. Do not change the ternary rendering behavior or imply that both panels remain mounted.

## F29 [minor] apps/mobile/src/features/live-call/live-header.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/features/live-call/live-header.tsx around lines 98 - 103, Update the mode label rendering in the live header at the Text elements identified by testID "hud-rail-mode" and the corresponding second occurrence: remove the toUpperCase() transformation so the accessibility text remains title-cased, and apply the existing textTransform styling approach instead.

## F30 [minor] apps/mobile/src/features/mascot/mascot-stage.test.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/features/mascot/mascot-stage.test.tsx around lines 43 - 62, Update the expo-image mock in mascot-stage.test.tsx to forward tintColor and contentFit to the rendered View, preserving their values for assertions. Strengthen the duotone test to inspect the tinted image rather than only the first image label, and add an assertion in the placement test covering the patch image’s fill contentFit so changes to contain fail.

## F31 [minor] apps/mobile/src/app/(app)/(tabs)/account.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/app/(app)/(tabs)/account.tsx around lines 306 - 331, Add aria-disabled={busy} to the delete-account-cancel Pressable alongside its existing disabled prop, matching the accessibility state exposed by delete-account-confirm while preserving the current cancel behavior.

Suggested code:

```
      <Pressable
        testID="delete-account-confirm"
        accessibilityRole="button"
        disabled={busy}
        aria-disabled={busy}
        onPress={() => void deleteAccount()}
        style={({ pressed }) => (pressed ? styles.pressed : undefined)}
      >
        <ChamferSurface
          fill={palette.ink}
          style={styles.key}
          contentStyle={styles.keyContent}
        >
          <Text style={[styles.keyLabel, { color: palette.onInk }]}>
            {busy ? 'DELETING…' : 'CONFIRM DELETE'}
          </Text>
        </ChamferSurface>
      </Pressable>
      <Pressable
        testID="delete-account-cancel"
        accessibilityRole="button"
        disabled={busy}
        aria-disabled={busy}
        onPress={() => {
          setConfirming(false);
        }}
        style={({ pressed }) => [styles.whisperRow, pressed && styles.pressed]}
```

## F32 [minor] apps/mobile/src/components/auth-form.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/components/auth-form.tsx around lines 208 - 212, Update the error Text rendering in the auth form to be announced by screen readers when a failed submission adds or changes the message, using the platform’s accessibility announcement/live-region semantics while preserving the existing visual styling and testID. Ensure the announcement reflects error.message and does not rely on the colour-only field state.

Suggested code:

```
        {error !== null ? (
          <Text
            testID="auth-error"
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
            role="alert"
            style={[styles.error, { color: palette.inkSoft }]}
          >
            {error.message}
          </Text>
        ) : null}
```

## F33 [minor] apps/mobile/src/features/meetings/format.ts

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/features/meetings/format.ts around lines 113 - 120, Replace epoch-based subtraction when computing week boundaries in both the date-formatting logic and groupMeetingsByRecency with calendar-based local-date arithmetic, ensuring weekStart represents local midnight exactly six calendar days before today across DST transitions. Keep the existing Today, weekday, and fallback formatting behavior unchanged.

Suggested code:

```
  const day = startOfLocalDay(date);
  const today = startOfLocalDay(now);
  if (day === today) return 'Today';

  const weekStart = startOfLocalDay(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6),
  );
  if (day >= weekStart && day < today) return formatWeekday(isoTime, locale);

  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
```

## F34 [minor] apps/mobile/src/features/notes/follow-up-panel.test.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/features/notes/follow-up-panel.test.tsx around lines 81 - 85, Add a positive rendering assertion to the `offers no retry for notes that simply have not landed` test, anchoring it on the `follow-up-state` element before retaining the existing absence check for `follow-up-retry`. Ensure the test verifies the state card renders while retry remains unavailable.

Suggested code:

```
  it('offers no retry for notes that simply have not landed', () => {
    renderPanel({ failure: mapFollowUpFailure(409, 'notes_not_ready') });

    expect(screen.getByTestId('follow-up-state')).toBeInTheDocument();
    expect(screen.queryByTestId('follow-up-retry')).toBeNull();
  });
```

## F35 [minor] apps/mobile/src/features/meetings/meeting-card.test.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/features/meetings/meeting-card.test.tsx around lines 175 - 179, Replace the ineffective negative waitFor in the third-colour failure test with a positive synchronization signal that reflects the rendered tree settling, then perform the polygon absence assertion synchronously. Keep the existing expectDuotoneOnly(container, cobaltPalette) validation and ensure the test would fail if a polygon appears after rendering.

Suggested code:

```
    // The failure is the classic place a third colour arrives (spec §11).
    // Settle on a node the failure card does draw, then assert the absence once.
    await screen.findByTestId(`meeting-meta-${ID}`);
    expect(container.querySelector('polygon')).toBeNull();
    expectDuotoneOnly(container, cobaltPalette);
```

## F36 [minor] apps/mobile/src/features/meetings/detail-tabs.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/features/meetings/detail-tabs.tsx around lines 25 - 33, Replace the plain TABS array with a Record-backed label map and a separate TAB_ORDER list covering every DetailTab member, so adding a new tab requires updating the labels. Derive the rendered tab entries by mapping TAB_ORDER and reading labels from TAB_LABELS, preserving the existing order and labels.

## F37 [minor] apps/mobile/src/features/stream/thinking-indicator.test.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/features/stream/thinking-indicator.test.tsx around lines 156 - 162, The test only validates the THINKING_BARS constants and never exercises ThinkingIndicator. Render the component and inspect the withTiming/withRepeat animation arguments, as established by the other tests, to verify each bar’s distinct sweepMs reaches the rendered animation; ensure the test would fail if durationMs={bar.sweepMs} were replaced with a shared hardcoded duration.

## F38 [minor] apps/mobile/src/app/(app)/meetings/[id].tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/app/(app)/meetings/[id].tsx around lines 105 - 107, Update the BackEyebrow onPress handler in the meeting screen to check router.canGoBack() before calling router.back(); when no history exists, navigate to the meetings-list route instead. Preserve the existing back behavior when navigation history is available.

## F39 [minor] apps/mobile/src/screen-tests/tabs-account.test.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/screen-tests/tabs-account.test.tsx around lines 111 - 117, Rename the test around `renderAccount` to make clear that the signed-in email is verified while the `ACTIVE` plan chip is only a placeholder, not an asserted account fact. Keep the `plan-chip` assertion intact, but explicitly frame it as placeholder behavior so future plan-tier changes do not misinterpret this test as billing coverage.

Suggested code:

```
  it('says who is signed in', async () => {
    renderAccount();
    await settle();

    expect(screen.getByTestId('signed-in-email')).toHaveTextContent('ada@nova.test');
    // The chip is a PLACEHOLDER — `/me` carries no plan tier yet (CLAUDE.md, spec
    // §10 wire workstream). This pins the current shape, not a verified plan.
    // When `/me` gains a tier, this assertion must be driven from the hook.
    expect(screen.getByTestId('plan-chip')).toHaveTextContent('ACTIVE');
  });
```

## F40 [minor] apps/mobile/src/screen-tests/meeting-detail.test.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/screen-tests/meeting-detail.test.tsx around lines 359 - 367, Strengthen the processing-state test around the `MeetingDetailScreen` follow-up flow by asserting the exact `notes_not_ready` copy rendered by `features/notes/follow-up-panel.tsx`. Keep the existing state and retry assertions, and verify the processing-specific text so the test distinguishes it from failed and none states.

## F41 [minor] apps/mobile/src/screen-tests/root-layout.test.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/screen-tests/root-layout.test.tsx around lines 104 - 117, Update the test around RootLayout to exercise an actual theme transition: render with the initial auto/cobalt state, assert the cobalt backdrop and navigation theme, then trigger the appearance/storage setter used by Account and wait for both values to update to the new palette. Keep the assertions coupled so the test verifies contentStyle and navigationTheme change together, rather than only validating initial restoration.

## F42 [minor] apps/mobile/src/screen-tests/tabs-live.test.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/screen-tests/tabs-live.test.tsx around lines 239 - 263, Update the test around the render and goLive handshake so real-time advancement is enabled only while completing goLive(), then disable it before advancing timers and capturing midWait. Keep the thinking-word assertion under deterministic fake timers, ensuring the interval cannot advance between reading midWait and the subsequent suggestionStart assertion.

Suggested code:

```
  it('does not restart her wait when the answer starts', async () => {
    // The card is drawn on the press and re-keyed nowhere: `suggestion.start` names
    // the answer, it does not introduce a new card. A key change here would remount
    // the thinking indicator and snap the word back to LISTENING mid-wait.
    render(<LiveScreen />);
    const socket = await goLive();

    // Real time only for the handshake above; the wait below is measured on a
    // clock this test controls.
    vi.useFakeTimers();
    try {
      respond('push on the timeline');

      act(() => {
        vi.advanceTimersByTime(THINKING_BEAT_MS * 2 + 40);
      });
      const midWait = screen.getByTestId('thinking-word').textContent;
      expect(midWait).not.toBe(thinkingWordAt(0));

      act(() => {
        socket.receive(suggestionStart());
      });

      expect(screen.getByTestId('thinking-word').textContent).toBe(midWait);
    } finally {
      vi.useRealTimers();
    }
  });
```

## F43 [minor] apps/mobile/src/screen-tests/sign-in.test.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/screen-tests/sign-in.test.tsx around lines 286 - 306, Update the test around the second auth.signIn call to return a pending promise, click submit without awaiting request completion, and assert auth-error is absent while that promise remains unresolved. Then resolve the pending attempt and await act so the test still completes cleanly, proving the failure is cleared when the next attempt starts rather than only after success.

Suggested code:

```
  it('clears the last failure when the next attempt starts', async () => {
    auth.signIn.mockResolvedValue({
      ok: false,
      kind: 'network',
      message: 'Network request failed',
    });

    render(<SignInScreen />);
    fillCredentials();
    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-button'));
    });
    expect(screen.getByTestId('auth-error')).toBeInTheDocument();

    // Hold the next attempt open: the claim is that the stale rejection goes at
    // the START of it, not when it happens to succeed.
    let settle: (result: AuthActionResult) => void = () => undefined;
    auth.signIn.mockReturnValue(
      new Promise<AuthActionResult>((resolve) => {
        settle = resolve;
      }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-button'));
    });

    expect(screen.queryByTestId('auth-error')).toBeNull();

    await act(async () => {
      settle({ ok: true });
    });
    expect(screen.queryByTestId('auth-error')).toBeNull();
  });
```

## F44 [trivial] apps/mobile/src/features/live-call/steer-pairing.ts

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/features/live-call/steer-pairing.ts at line 42, Track the unbounded lifetime of the known and byId maps in pairSteerArrivals: prune entries that are no longer present in the caller’s current suggestion list before storing or returning the maps, so memory and copy costs follow the visible set rather than every suggestion ever seen. Update the related map handling around pairSteerArrivals and its byId state while preserving existing pairing behavior.

## F45 [trivial] apps/mobile/src/features/notes/transcript.test.ts

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/features/notes/transcript.test.ts around lines 96 - 111, Update the first speakerTag test to either verify the actual required me/them mapping with an assertion that distinguishes it from generic uppercasing, or rename it to describe the behavior currently implemented by speakerTag: uppercasing a known non-null label. Keep the separate diarized-label and null-guard coverage unchanged.

## F46 [trivial] apps/mobile/src/features/notes/transcript.ts

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/features/notes/transcript.ts around lines 38 - 50, Update speakerTag to explicitly map the recognized user and other-speaker labels to the spec’s ME and THEM tags, while preserving unrecognized diarizer labels as provided and returning null for null input. Add or update transcript tests to verify these mappings and prevent future label changes from silently removing the convention.

Suggested code:

```
export function speakerTag(speaker: string | null): string | null {
  if (speaker === null) {
    return null;
  }

  const normalised = speaker.toLowerCase();
  if (normalised === 'me' || normalised === 'them') {
    return normalised.toUpperCase();
  }

  // A diarizer label names a voice, not a person: show it as given.
  return speaker.toUpperCase();
}
```

## F47 [trivial] apps/mobile/src/features/notes/transcript-panel.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/features/notes/transcript-panel.tsx around lines 83 - 96, Memoize the grouped transcript and the FlatList renderItem callback in the transcript panel component. Use hooks above all early returns so they execute unconditionally, recompute grouping only when state.turns changes, and keep the callback stable while rendering Turn with the current palette.

Suggested code:

```
import { useCallback, useMemo } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

export function TranscriptPanel({
  state,
  palette,
  onRetry,
}: TranscriptPanelProps): React.JSX.Element {
  const turns = state.status === 'success' ? state.turns : null;
  const blocks = useMemo(
    () => (turns === null ? [] : groupTranscriptBySpeaker(turns)),
    [turns],
  );
  const renderItem = useCallback(
    ({ item }: { item: TranscriptBlock }) => (
      <Turn block={item} palette={palette} />
    ),
    [palette],
  );

  if (state.status === 'idle' || state.status === 'loading') {
    // existing early-return body
  }

  return (
    <FlatList
      testID="transcript-panel"
      data={blocks}
      keyExtractor={(_, index) => String(index)}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      renderItem={renderItem}
    />
  );
}
```

## F48 [trivial] apps/mobile/src/features/live-call/copilot-pane.test.ts

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/features/live-call/copilot-pane.test.ts around lines 38 - 85, The copilot-pane test suite lacks coverage for the pin/auto-scroll behavior and placeholderFor. Add render tests around the pane component that verify a drag followed by onContentSizeChange does not call scrollToEnd, and that a bottom-pinned onScroll followed by onContentSizeChange does call it. Exercise the relevant handlers and PIN_THRESHOLD_PX behavior using the existing test utilities and cover placeholderFor as part of the added tests.

## F49 [trivial] apps/mobile/src/hooks/use-meeting-transcript.ts

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/hooks/use-meeting-transcript.ts around lines 14 - 20, Extract the shared fetch/timeout, abort, Zod parsing, and field-path warning logic from useMeetingTranscript and useMeetings into a helper such as fetch-json.ts that accepts a schema and returns a discriminated result. Remove duplicated constants and failure handling from both hooks, while keeping hook-specific policies—including the 404 message, loading transition, and silent-failure behavior—at their respective call sites.

## F50 [trivial] apps/mobile/src/hooks/use-meeting-transcript.test.ts

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/hooks/use-meeting-transcript.test.ts around lines 36 - 38, Update the test cleanup around the meeting transcript tests to call vi.useRealTimers() in afterEach alongside vi.unstubAllGlobals(), ensuring fake timers are restored even when a test fails. Extend the useMeetingTranscript error coverage with a 404 response case and assert the error message is “This meeting is no longer available.”, while preserving the existing server-error test.

## F51 [trivial] apps/mobile/src/features/live-call/call-clock.test.ts

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/features/live-call/call-clock.test.ts around lines 105 - 149, Add a test for useCallClock covering a false-to-true running transition without changing the attempt value, including elapsed time before the transition, and assert the intended elapsedMs value after reconnecting. Anchor the new case alongside the existing useCallClock tests and ensure it exercises the implementation’s running-based reset path.

Suggested code:

```
  it('zeroes for the next call rather than resuming the last one', () => {
    const { result, rerender } = renderHook(
      ({ running, attempt }: Attempt) => useCallClock(running, attempt),
      { initialProps: { running: false, attempt: 0 } },
    );

    rerender({ running: true, attempt: 1 });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    rerender({ running: false, attempt: 1 });
    rerender({ running: true, attempt: 2 });

    expect(result.current.elapsedMs).toBe(0);
  });

  it('does not restart the clock when one call re-connects', () => {
    const { result, rerender } = renderHook(
      ({ running, attempt }: Attempt) => useCallClock(running, attempt),
      { initialProps: { running: false, attempt: 0 } },
    );

    rerender({ running: true, attempt: 1 });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    rerender({ running: false, attempt: 1 });
    rerender({ running: true, attempt: 1 });

    expect(result.current.elapsedMs).toBeGreaterThanOrEqual(30_000);
  });

  it('has not run before the first call', () => {
    const { result } = renderHook(() => useCallClock(false, 0));

    expect(result.current.ran).toBe(false);
    expect(result.current.elapsedMs).toBe(0);
  });

  it('does not lend a finished call’s history to the next attempt', () => {
    // The failure this pins: the screen is a TAB and stays mounted, so a start that
    // never connects, pressed after a call that did, would otherwise still report
    // a call worth summarising.
    const { result, rerender } = renderHook(
      ({ running, attempt }: Attempt) => useCallClock(running, attempt),
      { initialProps: { running: false, attempt: 0 } },
    );

    rerender({ running: true, attempt: 1 });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    rerender({ running: false, attempt: 1 });
    expect(result.current.ran).toBe(true);

    // Pressed again; this one never goes live.
    rerender({ running: false, attempt: 2 });

    expect(result.current.ran).toBe(false);
    expect(result.current.elapsedMs).toBe(0);
  });
```

## F52 [trivial] apps/mobile/src/app/(app)/meetings/[id].tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/app/(app)/meetings/[id].tsx around lines 196 - 201, Export a named notes-not-ready failure constant alongside NO_NOTES_TO_DRAFT_FROM in follow-up.ts, initialized through the existing mapping, then update the queued/processing branches in the meeting screen to return that constant instead of calling mapFollowUpFailure with a hard-coded status. Keep the failed/none branch unchanged.

## F53 [trivial] apps/mobile/src/features/stream/drain.test.ts

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/features/stream/drain.test.ts around lines 5 - 22, Add an afterEach hook within the createStreamDrain describe block to restore real timers with vi.useRealTimers(), ensuring cleanup runs even when the test assertion fails; remove reliance on the test’s trailing cleanup while preserving the existing timer behavior.

Suggested code:

```
describe('createStreamDrain', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drains a burst at a steady character rate, not all at once', () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const d = createStreamDrain({
      onText: (c) => out.push(c),
      onDone: () => {},
    });
    d.push('Honestly, because the problems');
    vi.advanceTimersByTime(50);
    const after50 = out.join('').length;
    expect(after50).toBeGreaterThan(0);
    expect(after50).toBeLessThan(10); // ~60cps → ~3 chars in 50ms, never the whole burst
    vi.advanceTimersByTime(2000);
    expect(out.join('')).toBe('Honestly, because the problems');
    d.dispose();
    vi.useRealTimers();
  });
```

## F54 [trivial] apps/mobile/src/testing/duotone.ts

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/testing/duotone.ts around lines 185 - 216, Add a concise comment immediately before the SVG branch’s continue in the element walk, documenting that react-native-svg emits fill and stroke as attributes and that the branch intentionally skips computed-style checks for those properties. Keep the existing behavior unchanged.

## F55 [trivial] apps/mobile/src/screen-tests/tabs-account.test.tsx

Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.

In @apps/mobile/src/screen-tests/tabs-account.test.tsx around lines 166 - 192, Connect the persistence tests so the value recorded by the appearance-cycle test is reused as the mocked storage result for restoration. Update the test flow around the appearance interaction and storage.setItem assertion, then render or reload the account screen and verify the corresponding palette is restored, rather than seeding an independent literal such as 'paper'.

Suggested code:

```
  it('cycles on press, and writes the pick down', async () => {
    renderAccount();
    await settle();

    act(() => {
      fireEvent.click(screen.getByTestId('appearance-row'));
    });

    expect(colorOf('appearance-cobalt')).toBe(INK);
    expect(storage.setItem).toHaveBeenCalledWith('nova.appearance', 'cobalt');
  });

  it('repaints the screen the moment the theme changes', async () => {
    // The row is not a label that updates — it is the whole app's palette. Paper
    // has to arrive on this screen too, or the setting is a lie about itself.
    storage.getItem.mockResolvedValue('paper');
    renderAccount();

    await waitFor(() => {
      expect(colorOf('appearance-paper')).toBe(normaliseColor(paperPalette.ink));
    });
    expect(
      normaliseColor(
        getComputedStyle(screen.getByTestId('account-screen')).backgroundColor,
      ),
    ).toBe(normaliseColor(paperPalette.canvas));
  });

  it('brings the pick back through a restart, whatever it wrote down', async () => {
    // The round trip, not two independent literals: whatever the writer emitted
    // is exactly what the next cold start is handed.
    const first = renderAccount();
    await settle();
    act(() => {
      fireEvent.click(screen.getByTestId('appearance-row'));
    });

    const [key, written] = storage.setItem.mock.calls.at(-1) ?? [];
    expect(key).toBe('nova.appearance');
    first.unmount();

    storage.getItem.mockResolvedValue(written ?? null);
    renderAccount();

    await waitFor(() => {
      expect(colorOf('appearance-cobalt')).toBe(INK);
    });
  });
```

