import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { tabBarClearance } from '@/design/tab-bar-metrics';
import { Space } from '@/design/tokens';
import { useCallClock } from '@/features/live-call/call-clock';
import {
  CapturePane,
  type CaptureTab,
} from '@/features/live-call/capture-pane';
import {
  CopilotPane,
  copilotEntries,
} from '@/features/live-call/copilot-pane';
import {
  HudRail,
  LiveHeader,
  SessionBanner,
} from '@/features/live-call/live-header';
import { liveAlertFor, type LiveAlert } from '@/features/live-call/session-alert';
import {
  EndedSummary,
  IdlePanel,
  QuotaCard,
} from '@/features/live-call/session-views';
import { SteerBar } from '@/features/live-call/steer-bar';
import {
  emptySteerPairing,
  pairSteerArrivals,
  steerSubmitted,
} from '@/features/live-call/steer-pairing';
import { usePalette } from '@/hooks/use-appearance';
import { useLiveSession, type LiveStatus } from '@/hooks/use-live-session';

/**
 * The Live cockpit (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §4) — the
 * teleprompter screen the whole product exists for.
 *
 * Top to bottom while a call is up: the wordmark and the `◉ LIVE · mm:ss` HUD, the
 * capture pane (what was just said), the rail naming the prompt this call is locked
 * to, the copilot history — and at the bottom the steer field and the one key.
 *
 * Dumb, as the guardrails require: `useLiveSession` owns the socket, the meeting and
 * every piece of session state. What this screen owns is presentation state only —
 * which capture tab is open, and which answer each steer belongs to.
 *
 * ---------------------------------------------------------------------------
 * The MVP bridge
 * ---------------------------------------------------------------------------
 * why: spec §10. The one-button model needs a manual-trigger wire event that carries
 * the steer as USER GUIDANCE; that is a later server workstream. Until it lands
 * RESPOND rides the EXISTING `transcript.input` — so the key is armed only when the
 * field has something in it, and the steer is echoed back down as a `them` turn by
 * the server (spec §4 says the steer is never a fake transcript turn: that half of
 * the promise is the wire's to keep, not this screen's). The chip already renders
 * against the answer it shaped, so when the wire is swapped underneath this UI does
 * not change.
 */

/** Which of the four screens §4 draws is on. */
type CockpitView = 'idle' | 'cockpit' | 'ended' | 'quota';

/**
 * The view, from the session's own state.
 *
 * `ran` is what separates the two meanings of `closed`: a call that finished has a
 * handoff worth showing, and a start that never connected has nothing to hand off.
 *
 * The quota answer outranks the status because the server has already closed the
 * call by the time it arrives — but it is a VIEW, not a mode the screen gets stuck
 * in: the idle panel renders under that card, and the next start clears the error
 * that put it there.
 */
function cockpitView(
  status: LiveStatus,
  alert: LiveAlert | null,
  ran: boolean,
): CockpitView {
  if (alert?.kind === 'quota') return 'quota';
  if (status === 'connecting' || status === 'live') return 'cockpit';
  if (status === 'idle') return 'idle';
  return ran ? 'ended' : 'idle';
}

export default function LiveScreen(): React.JSX.Element {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  // The capture pane is TABBED (`docs/DESIGN/notes-ui.md` §5.1): live notes need a
  // home during the call, and the design prototype's card is transcript-only.
  const [captureTab, setCaptureTab] = useState<CaptureTab>('transcript');
  const live = useLiveSession({ notesPanelVisible: captureTab === 'notes' });
  // Which press we are on. The clock needs it because this screen is a TAB and never
  // unmounts: without it, a start that fails would inherit the previous call's
  // summary. Every start path bumps it, including the ones that fail before the hook
  // ever reaches `connecting`.
  const [attempt, setAttempt] = useState(0);
  const clock = useCallClock(live.status === 'live', attempt);

  const [pairing, setPairing] = useState(emptySteerPairing);
  // Prop-derived state, adjusted DURING RENDER — the same shape `StreamingText`
  // uses, and the only one this repo's `set-state-in-effect` lint leaves open. The
  // pairing is idempotent per suggestion id, so this settles on the first pass.
  const paired = pairSteerArrivals(
    pairing,
    live.suggestions.map((suggestion) => suggestion.id),
  );
  if (paired !== pairing) setPairing(paired);

  const alert = liveAlertFor(live.errorMessage);
  const view = cockpitView(live.status, alert, clock.ran);
  const inSession = live.status === 'connecting' || live.status === 'live';

  const start = (): void => {
    // A new call starts with no chips: the steers of the last one belong to answers
    // that are already gone.
    setPairing(emptySteerPairing);
    setAttempt((previous) => previous + 1);
    // `start()` clears the hook's `errorMessage`, which is what lets a refused call —
    // a spent quota included — be tried again rather than leaving the screen parked
    // on the card that reported it. The server re-gates the attempt.
    void live.start();
  };

  const respond = (steer: string): void => {
    setPairing((previous) => steerSubmitted(previous, steer));
    live.sendInput(steer);
  };

  const showNotes = (tab: CaptureTab): void => {
    setCaptureTab(tab);
    // Revealing the panel is what clears the dot — not the update that set it.
    if (tab === 'notes') live.markNotesSeen();
  };

  const banner =
    alert?.kind === 'banner' ? (
      <SessionBanner palette={palette} text={alert.text} />
    ) : null;

  return (
    <View style={[styles.root, { backgroundColor: palette.canvas }]}>
      <SafeAreaView
        style={[
          styles.safeArea,
          // The tab bar floats (position: absolute) and reserves no layout space,
          // so this screen has to leave room or the bottom bar hides under it.
          { paddingBottom: tabBarClearance(insets.bottom) },
        ]}
        edges={['top']}
      >
        {/* Load-bearing on iOS: the steer field sits at the bottom of the screen,
            and without this the keyboard covers the thing being typed into. */}
        <KeyboardAvoidingView
          style={styles.column}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <LiveHeader
            palette={palette}
            status={live.status}
            elapsedMs={clock.elapsedMs}
            onEnd={inSession ? live.stop : null}
          />

          {view === 'cockpit' ? (
            <>
              <CapturePane
                tab={captureTab}
                onSelect={showNotes}
                turns={live.transcript}
                notes={live.liveNotes}
                palette={palette}
              />
              <HudRail palette={palette} mode={live.mode} />
              {banner}
              <CopilotPane
                entries={copilotEntries(live.suggestions, paired)}
                palette={palette}
                status={live.status}
              />
              <SteerBar
                palette={palette}
                canSend={live.canSend}
                onRespond={respond}
              />
            </>
          ) : (
            <View style={styles.stack}>
              {banner}
              {view === 'quota' ? <QuotaCard palette={palette} /> : null}
              {view === 'ended' ? (
                <EndedSummary
                  palette={palette}
                  onSeeCalls={() => {
                    router.push('/');
                  }}
                />
              ) : null}
              {/* Under the quota card too. Spec §4's "no dead retry" is about the
                  REFUSED call — nothing here re-runs it — and not about locking the
                  user out of the screen: this one stays mounted for the life of the
                  app, so a card with no way off it would outlive the quota that
                  raised it. Starting again is a new session the server re-gates. */}
              <IdlePanel
                palette={palette}
                mode={live.mode}
                onSelectMode={live.setMode}
                canPickMode={live.canPickMode}
                onStart={start}
              />
            </View>
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  safeArea: {
    flex: 1,
    paddingHorizontal: Space.xl,
  },
  column: {
    flex: 1,
    gap: Space.lg,
    paddingTop: Space.lg,
  },
  // The inner views sit UNDER the header, which already carries the top padding.
  stack: {
    flex: 1,
    gap: Space.lg,
  },
});
