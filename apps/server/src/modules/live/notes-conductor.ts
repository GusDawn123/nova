import {
  LIVE_PROTOCOL_VERSION,
  type ConversationType,
  type MeetingNotes,
  type ServerLiveEvent,
} from "@nova/shared";

import type { LiveNotesStore } from "../../db/live-notes.js";
import { withMeter, type LlmRouter, type Meter } from "../llm/index.js";
import {
  createLiveFoldRunner,
  emptyLiveNotes,
  initialFoldState,
  joinTranscriptText,
  type FoldState,
  type TranscriptTurn,
} from "../notes/index.js";

import {
  notesConductorConfig,
  type NotesConductorConfig,
} from "./notes-conductor-config.js";
import { evaluateNotesTrigger } from "./notes-trigger.js";
import type { LiveLogger } from "./ports.js";

/**
 * The running-notes loop (Phase 8, docs/DESIGN/live-notes.md §4). It watches the
 * same transcript stream as the copilot conductor and shares nothing with it: a
 * separate cadence, a separate gate, a separate model call, separate state.
 *
 * It holds the AUTHORITATIVE notes state; the model only ever proposes deltas,
 * which `modules/notes` folds under server-side clamps. What lives here is purely
 * the loop: when to fold, what has accrued since the last one, and what to do with
 * the result.
 *
 * ## The delta lifecycle is the one thing that must not be gotten wrong
 *
 * The fold is stateful and NEVER re-reads the transcript, so anything consumed by
 * a fold that did not land is lost for the rest of the call. The delta is
 * therefore RETAINED on every unhappy path — gate no-fire, LLM error, abort,
 * schema reject, and `changed: false` — and cleared in exactly ONE place: after a
 * fold that produced a real change. If you are editing this file, that is the
 * invariant to preserve.
 */

/** The conductor's public surface — fed final utterances by the LiveSession. */
export interface LiveNotesConductor {
  onFinal(text: string, speaker: string | null): void;
  /** Abort any in-flight fold and stop the loop. Never writes on the way out. */
  dispose(): void;
}

/** Per-session args the transport supplies at `session.start`. */
export interface NotesConductorFactoryArgs {
  readonly send: (event: ServerLiveEvent) => void;
  readonly userId: string;
  readonly meetingId: string;
}

/**
 * Builds a {@link LiveNotesConductor} once a session is authenticated and its
 * owner/meeting are known — the notes twin of {@link
 * import("./conductor.js").LiveConductorFactory}. Wired by `metering-wiring.ts`
 * closing over the live router, the store, the plan reader and the meter;
 * undefined on a boot without an LLM key or without the DB, which is what makes
 * the fail-closed posture literal: no factory, no conductor, no spend.
 */
export type LiveNotesConductorFactory = (
  args: NotesConductorFactoryArgs,
) => LiveNotesConductor;

export interface LiveNotesConductorDeps {
  /** Emit a typed event down the socket (the session's own `send`). */
  send: (event: ServerLiveEvent) => void;
  /** A live-tuned llm router. Metered via {@link LiveNotesConductorDeps.meter}. */
  router: LlmRouter;
  /** Persistence for the preview; also the hydration source at start. */
  store: LiveNotesStore;
  readonly userId: string;
  readonly meetingId: string;
  /**
   * Seeds the notes title until the first narrative fold replaces it. Optional
   * because the session does NOT know it: the ownership guard reads one column,
   * and adding a title fetch would put a query on the session-start path the
   * design explicitly keeps clear (§8). Nothing is observable before the first
   * fold anyway — no row exists, so the REST read model answers null and the
   * socket has emitted nothing — and that fold's narrative window is open.
   */
  readonly meetingTitle?: string;
  /** ISO start time, for relative-deadline resolution. Null → the injected clock. */
  readonly startedAt?: string | null;
  /**
   * Entitlement (Phase 8, §8). Resolved LAZILY on the first tick — never at
   * session start, which already chains concurrency → daily cap → ownership →
   * quota and must not grow — then LATCHED for the session, so a RevenueCat
   * downgrade mid-call does not kill a call in progress.
   *
   * Fail-CLOSED: unresolvable entitlement stops the loop. This gates a paid
   * capability, not a budget; the quota check above is the fail-open one.
   */
  isEntitled?: () => Promise<boolean>;
  /** Per-call meter (`metering.meterFor`); threaded into every model call. */
  meter?: Meter;
  logger?: LiveLogger;
  config?: NotesConductorConfig;
  /** Injected clock (fake-timer tests); defaults to Date.now. */
  now?: () => number;
  /**
   * Spend stop. Checked once per tick BEFORE any model call; true stops the loop
   * permanently. Recording spend is not limiting spend — the global kill-switch
   * only refuses NEW sessions, so a call already in progress needs its own brake.
   */
  isOverQuota?: () => Promise<boolean>;
}

/** ~4 chars per token — the same heuristic the notes pipeline uses, no tokenizer. */
const CHARS_PER_TOKEN = 4;

export function createLiveNotesConductor(
  deps: LiveNotesConductorDeps,
): LiveNotesConductor {
  const config = deps.config ?? notesConductorConfig;
  const now = deps.now ?? Date.now;
  const logger = deps.logger;

  const runner = createLiveFoldRunner({
    router: deps.meter ? withMeter(deps.router, deps.meter) : deps.router,
    config: {
      maxChurnPerFold: config.maxChurnPerFold,
      churnFraction: config.churnFraction,
      maxItemsPerList: config.maxItemsPerList,
    },
    // The runner's log lines carry only SHAPE (salvage/repair flags, drop counts
    // and reasons — never transcript text, RULES §6), so correlation has to be
    // injected here. This wrapper is the single construction site for the runner,
    // which makes it the right place: threading ids through FoldRequest would
    // duplicate a cross-cutting concern into every individual log call.
    // why user_id: it was missing, so fold-runner lines could not be tied to a
    // user during an incident — RULES §6 requires both ids on structured logs.
    logger: {
      info: (fields: Record<string, unknown>, msg: string): void => {
        logger?.info?.(
          { ...fields, user_id: deps.userId, meeting_id: deps.meetingId },
          msg,
        );
      },
      error: (fields: Record<string, unknown>, msg: string): void => {
        logger?.error(
          { ...fields, user_id: deps.userId, meeting_id: deps.meetingId },
          msg,
        );
      },
    },
  });

  /** The whole call so far, for the quote check (bounded — see the config). */
  const transcript: TranscriptTurn[] = [];
  /** Accrued since the last fold that LANDED. Retained on every failure path. */
  let delta: TranscriptTurn[] = [];

  let notes: MeetingNotes = emptyLiveNotes(deps.meetingTitle ?? "");
  let state: FoldState = initialFoldState(null);
  let rev = 0;
  let foldsSpent = 0;
  let foldsSinceNarrative = 0;
  let itemsAtLastNarrative = 0;
  /**
   * What the classifier decided, until the reducer's latch adopts it. Kept until
   * `notes.conversationType` matches, so a fold that failed does not lose the
   * classification — it simply rides the next one. `notes.conversationType` is the
   * source of truth; this is only ever a pending proposal.
   */
  let classifiedType: ConversationType | null = null;
  let classified = false;
  /** Entitlement is resolved once, on the first tick, then latched. */
  let entitlementResolved = false;

  let inFlight: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  /** Terminal: budget or quota exhausted. Distinct from `disposed` (teardown). */
  let stopped = false;

  /**
   * Read the teardown flags through functions, never directly.
   *
   * `dispose()` can fire at ANY await point in the tick — the socket closes and
   * the phone call ends mid-fold constantly. Reading `disposed` as a bare variable
   * lets TypeScript's control-flow analysis narrow it to `false` after the first
   * check and treat every later check as dead code, which is exactly wrong here:
   * the value it narrowed is the one that changes. A call is opaque to narrowing,
   * so these re-read for real. Same reason `conductor.ts` routes its supersede
   * check through `isCurrent()`.
   */
  const isDisposed = (): boolean => disposed;
  const isStopped = (): boolean => stopped;

  const callDate = resolveCallDate(deps.startedAt ?? null, now);

  function log(fields: Record<string, unknown>, msg: string): void {
    logger?.error(
      { user_id: deps.userId, meeting_id: deps.meetingId, ...fields },
      msg,
    );
  }

  /** Total itemized entries — drives the narrative window's item-delta trigger. */
  function itemCount(value: MeetingNotes): number {
    const insights = value.typeInsights;
    const armCount =
      insights.kind === "sales"
        ? insights.objections.length + insights.buyingSignals.length
        : insights.kind === "interview"
          ? insights.questionsAsked.length + insights.answersToRevisit.length
          : 0;
    return (
      value.decisions.length +
      value.actionItems.length +
      value.openQuestions.length +
      value.risks.length +
      armCount
    );
  }

  function emit(): void {
    deps.send({
      v: LIVE_PROTOCOL_VERSION,
      type: "notes.update",
      notes,
      rev,
    });
  }

  function scheduleTick(): void {
    if (timer !== null || isDisposed() || isStopped()) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, config.foldIntervalMs);
  }

  /** Re-arm only while there is still something to fold. */
  function rearm(): void {
    if (isDisposed() || isStopped() || delta.length === 0) return;
    scheduleTick();
  }

  /**
   * Hydrate from `live_notes` and, if a row exists, emit it immediately.
   *
   * This is why the conductor hydrates at START rather than replaying on
   * reconnect: there IS no session resume — `session.start` mints a fresh session
   * and the one-per-user registry refuses the new socket until the old disposer
   * runs. A conductor that waited for a reconnect signal would begin with an empty
   * prior and the first fold would wipe an hour of accrued notes.
   */
  async function hydrate(): Promise<void> {
    const row = await deps.store.readLiveNotes(deps.meetingId, deps.userId);
    if (isDisposed() || row === null) return;
    notes = row.notes;
    rev = row.rev;
    state = initialFoldState(row.notes);
    classified = row.notes.conversationType !== "casual";
    itemsAtLastNarrative = itemCount(row.notes);
    emit();
  }

  async function tick(): Promise<void> {
    // 0. Never fold against un-hydrated state. Awaiting the latch is a no-op once
    //    the first read has landed; on a slow DB it is what stops the first fold
    //    from overwriting the persisted row with a fresh rev 1.
    await hydrated;

    // 1. Single in-flight latch — this is what makes overlapping folds
    //    impossible. The delta keeps accruing while a fold is out.
    //    Re-checked AFTER the await: disposal can land while hydration is out.
    if (isDisposed() || isStopped() || inFlight !== null) {
      rearm();
      return;
    }

    // 2a. Entitlement, once, lazily, latched — and BEFORE the budget/quota checks
    //     so an unentitled session never touches the metering DB either.
    if (!entitlementResolved && deps.isEntitled !== undefined) {
      entitlementResolved = true;
      let entitled = false;
      try {
        entitled = await deps.isEntitled();
      } catch (err: unknown) {
        // Fail CLOSED (§8): a capability gate that cannot answer denies. Contrast
        // the quota check below, which fails open because it protects spend.
        log({ err }, "live.notes_conductor.entitlement_check_failed");
      }
      if (!entitled) {
        stopped = true;
        log({}, "live.notes_conductor.not_entitled");
        return;
      }
      if (isDisposed()) return;
    }

    // 2b. Budget and quota are terminal, not skips.
    if (foldsSpent >= config.maxFoldsPerSession) {
      stopped = true;
      log({ folds_spent: foldsSpent }, "live.notes_conductor.budget_exhausted");
      return;
    }
    if (await isOverQuota()) {
      stopped = true;
      log({}, "live.notes_conductor.quota_stop");
      return;
    }
    if (isDisposed()) return;

    // 3. Not enough new material to be worth a call.
    if (delta.length < config.minUtterancesPerFold) {
      rearm();
      return;
    }

    // 4. The gate, with the token FORCE-FIRE behind it. A gate tuned toward quiet
    //    must never starve a diffuse-but-substantive stretch (§5).
    const gate = evaluateNotesTrigger(delta);
    const deltaTokens = estimateDeltaTokens(delta);
    if (!gate.fire && deltaTokens < config.maxDeltaTokens) {
      rearm();
      return;
    }

    const controller = new AbortController();
    inFlight = controller;
    // Snapshot what this fold is consuming BY IDENTITY, not by index.
    // why: `delta` does not only grow underneath us — the maxDeltaTurns cost
    // backstop trims it from the FRONT. A count captured here would then point at
    // the wrong entries, and clearing by index dropped turns this fold never
    // consumed. Holding the turn objects themselves makes the clear exact under
    // any concurrent growth OR trim.
    const consumed = delta.slice();

    try {
      // 5. Classify once, past the threshold, while still casual. Latched after —
      //    one metered call per session, never repeated.
      if (
        !classified &&
        transcript.length >= config.classifyMinTurns &&
        notes.conversationType === "casual"
      ) {
        classifiedType = await runner.classify(transcript, controller.signal);
        classified = true;
        if (isDisposed()) return;
      }
      const pendingType =
        classifiedType !== null && classifiedType !== notes.conversationType
          ? classifiedType
          : undefined;

      // The narrative window: open on the FIRST fold (there is no narrative yet,
      // so there is nothing to churn and the placeholder title/tldr should not
      // survive a single fold), then every Nth fold, or once enough items move.
      // Until one has landed it is REQUIRED, not offered — see FoldMessageParams.
      const narrativeRequired = !state.titleLatched;
      const narrativeOpen =
        narrativeRequired ||
        foldsSinceNarrative >= config.narrativeEveryNFolds ||
        Math.abs(itemCount(notes) - itemsAtLastNarrative) >=
          config.narrativeItemDelta;

      // 6. The fold itself.
      foldsSpent += 1;
      const outcome = await runner.fold({
        prior: notes,
        // The snapshot, not the live array: what the model reads must be exactly
        // what step 8 clears, even if a trim reshapes `delta` mid-call.
        delta: consumed,
        state,
        narrativeOpen,
        narrativeRequired,
        transcriptSoFar: joinTranscriptText(transcript),
        canLatchType: transcript.length >= config.classifyMinTurns,
        callDate,
        ...(pendingType !== undefined ? { classifiedType: pendingType } : {}),
        signal: controller.signal,
      });

      // A schema reject, an abort, or a teardown mid-fold: the delta STAYS.
      if (outcome === null || isDisposed() || controller.signal.aborted) return;
      // Every op dropped: no rev bump, no wire event, no write — and the delta is
      // retained, because nothing about it has actually been captured.
      if (!outcome.changed) return;

      // 7. It landed: bump, persist, emit.
      notes = outcome.notes;
      state = outcome.state;
      rev += 1;
      if (narrativeOpen) {
        foldsSinceNarrative = 0;
        itemsAtLastNarrative = itemCount(notes);
      } else {
        foldsSinceNarrative += 1;
      }

      const write = await deps.store.upsertLiveNotes({
        meetingId: deps.meetingId,
        userId: deps.userId,
        notes,
        rev,
      });
      if (write.status === "stale") {
        // Another writer is ahead of us — almost certainly a stale session that
        // has not torn down yet. Do not emit a rev the reader will never see.
        log({ rev }, "live.notes_conductor.write_stale");
        return;
      }
      if (isDisposed()) return;
      emit();

      // 8. THE ONLY PLACE THE DELTA CLEARS. Drop exactly what this fold consumed,
      //    matched by identity; turns that arrived — or survived a trim — while the
      //    model call was out are kept.
      const folded = new Set(consumed);
      delta = delta.filter((turn) => !folded.has(turn));
    } catch (err: unknown) {
      // Transport failure (LlmError / AllProvidersFailedError) or a store throw.
      // The delta is retained by simply not clearing it.
      log({ err }, "live.notes_conductor.fold_failed");
    } finally {
      if (inFlight === controller) inFlight = null;
      rearm();
    }
  }

  async function isOverQuota(): Promise<boolean> {
    if (deps.isOverQuota === undefined) return false;
    try {
      return await deps.isOverQuota();
    } catch {
      // Fail-OPEN on the spend check, matching the session-start quota posture
      // (adr-0007): a metering outage must not silently kill a paid feature.
      return false;
    }
  }

  function estimateDeltaTokens(turns: readonly TranscriptTurn[]): number {
    const chars = turns.reduce((sum, turn) => sum + turn.text.length, 0);
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }

  /**
   * The hydration latch. `tick()` awaits this before reading `notes`/`rev`.
   *
   * why: this used to be a bare `void hydrate()`, so a `readLiveNotes` slower than
   * `foldIntervalMs` let the first fold run against empty notes at rev 0 and then
   * write rev 1 straight over the persisted row — the same overwrite the catch
   * below warns about, reached by being slow rather than by failing. Rejections
   * are folded in here so awaiting the latch can never throw into the loop.
   */
  const hydrated: Promise<void> = hydrate().catch((err: unknown) => {
    // A hydration failure is survivable: the loop starts from empty notes rather
    // than not at all. It is NOT silent — an unnoticed one means the first fold
    // overwrites the row with a fresh set of ids.
    log({ err }, "live.notes_conductor.hydrate_failed");
  });

  return {
    onFinal(text, speaker) {
      if (isDisposed() || isStopped()) return;
      const trimmed = text.trim();
      if (trimmed === "") return;
      const turn: TranscriptTurn = { speaker, text: trimmed, tsMs: null };

      transcript.push(turn);
      if (transcript.length > config.transcriptWindowTurns) {
        transcript.splice(0, transcript.length - config.transcriptWindowTurns);
      }

      delta.push(turn);
      if (delta.length > config.maxDeltaTurns) {
        // Cost backstop, not a lifecycle event: keep the NEWEST turns, which are
        // what a fold is most likely to still act on.
        delta = delta.slice(delta.length - config.maxDeltaTurns);
      }

      scheduleTick();
    },

    dispose() {
      if (isDisposed()) return;
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // Abort in-flight and drop the pending delta WITHOUT writing: the post-call
      // pipeline reads the whole transcript regardless, so the last partial delta
      // is not load-bearing, and a write racing teardown risks a stale rev.
      inFlight?.abort();
      inFlight = null;
      delta = [];
    },
  };
}

/** The call's anchor date (UTC) for relative-deadline resolution. */
function resolveCallDate(startedAt: string | null, now: () => number): string {
  const parsed = startedAt !== null ? new Date(startedAt) : new Date(now());
  const base = Number.isNaN(parsed.getTime()) ? new Date(now()) : parsed;
  return base.toISOString().slice(0, 10);
}
