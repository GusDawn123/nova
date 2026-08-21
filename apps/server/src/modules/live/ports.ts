import type { LiveSession } from "./session.js";

/**
 * Seams the live-socket transport hangs vendor work off of. This task builds the
 * socket + protocol; Phases 3.3–5 plug the STT engine into these without
 * touching the transport.
 */

/**
 * Where received binary audio frames go after `session.start`. A NO-OP in this
 * task (the socket + teardown seam is what's being built); Task 4 replaces the
 * default with the STT relay. Kept synchronous and throwing-free — the transport
 * calls it in a hot loop and must never await or crash on a frame.
 */
export type AudioFrameHandler = (session: LiveSession, frame: Buffer) => void;

/** Default seam: swallow the frame. Real relaying arrives in a later task. */
export const noopAudioFrameHandler: AudioFrameHandler = () => {
  // intentionally empty — vendor relay is out of scope for this task.
};

/**
 * A session-scoped, run-exactly-once teardown latch. Every per-session resource
 * (vendor sockets, timers, abort controllers) registers its cleanup here; the
 * transport calls {@link Disposer.dispose} on close/error/end. Phones drop
 * constantly and an abandoned stream is a money leak (design doc), so this
 * running EXACTLY once — never zero, never twice — is a binding invariant.
 */
export interface Disposer {
  /**
   * Register a cleanup. If the disposer already ran, the callback fires
   * immediately (a resource that registered during/after teardown is still
   * cleaned up, not leaked).
   */
  add: (cleanup: () => void) => void;
  /** Run every registered cleanup once (LIFO). Idempotent: later calls no-op. */
  dispose: () => void;
  /** Whether {@link dispose} has already run. */
  readonly disposed: boolean;
}

/**
 * A committed (FINAL) transcript utterance to persist. Partials are NEVER
 * persisted (RULES: raw audio never stored; transcript TEXT finals only). `speaker`
 * / `tsMs` are nullable — the STT vendor may not diarize or timestamp every final.
 */
export interface TranscriptFinalRow {
  readonly meetingId: string;
  readonly userId: string;
  readonly content: string;
  readonly speaker: string | null;
  readonly tsMs: number | null;
}

/**
 * Persistence seam the live session writes durable memory through: store each FINAL
 * transcript, and stamp call completion (`meetings.ended_at`). Implemented by the
 * supabase adapter in `db/transcripts.ts` (service-role). Both methods may reject —
 * the session treats writes as fire-and-forget with error logging, because a DB
 * hiccup must NEVER stall or kill the socket relay (RULES). `markEnded` is idempotent
 * (only sets `ended_at` where currently null).
 *
 * `verifyMeetingOwnership` is the session-start parentage guard (Phase 4 review C1):
 * because these writes go through the SERVICE ROLE (which bypasses RLS and the DB
 * `with_check` parentage guard from migration 20260720150000), the socket transport
 * must itself confirm the client-supplied `meeting_id` names a LIVE meeting owned by
 * the authenticated caller BEFORE any STT starts or any transcript is written —
 * otherwise user B could stream a call onto user A's meeting_id (FK satisfied, RLS
 * bypassed), wedging A's delete/purge with foreign child rows. It resolves `true`
 * only for an existing, own, `deleted_at is null` meeting, `false` for
 * missing/wrong-owner/tombstoned, and REJECTS on a DB error so the session fails
 * CLOSED (a DB-unavailable start is refused, never silently accepted).
 */
export interface TranscriptPersister {
  saveFinal(row: TranscriptFinalRow): Promise<void>;
  markEnded(meetingId: string, userId: string): Promise<void>;
  verifyMeetingOwnership(meetingId: string, userId: string): Promise<boolean>;
}

/**
 * Minimal structured-error log sink (Fastify `app.log` shape). The session logs
 * persistence failures through it with `user_id` / `meeting_id` — NEVER transcript
 * content (RULES §6).
 */
export interface LiveLogger {
  error(fields: Record<string, unknown>, msg: string): void;
  /**
   * Optional info sink. The notes conductor reports fold telemetry through it
   * (how many ops the reducer clamped, and why) — the signal that would tell you
   * the model is fighting the churn ceiling. Optional so existing callers that
   * only supply `error` keep type-checking; Fastify's `app.log` has both.
   */
  info?(fields: Record<string, unknown>, msg: string): void;
}

/**
 * One live generation as it ended, for the dev-only answer ledger. TYPES ONLY
 * here — the module stays free of filesystem imports (the [no-disk] audit
 * covers this whole layer); the fs-writing implementation lives in the app
 * wiring (`src/debug-transcript.ts`), behind its env opt-in.
 */
export interface LlmDebugEntry {
  at: string;
  user_id: string | null;
  meeting_id: string | null;
  suggestion_id: string;
  trigger_text: string;
  answer_text: string;
  /**
   * The answer BEFORE the deterministic voice pass (2026-08-20 prompt-stack
   * redesign): raw-vs-shipped diffs in the ledger are the observation channel
   * that feeds the next prompt/idiom iteration. Same text as `answer_text`
   * whenever enforcement changed nothing.
   */
  raw_answer_text: string;
  /** Whether `enforceSpoken` rewrote anything — the quick diff-row filter. */
  enforcement_changed: boolean;
  /**
   * Every AI tell DETECTED in the raw answer (band ids from
   * `modules/prompt/enforce.ts`, e.g. `em-dash`, `banned-word:delve`) —
   * including word-class tells that are logged but never rewritten.
   */
  violations: string[];
  /** Mirrors the wire: `done`, `discard:<reason>`, or `done_after_error`. */
  outcome: string;
  duration_ms: number;
  input_tokens: number | null;
  cached_input_tokens: number | null;
}

/** The sink the conductor calls once per terminal wire event, when wired. */
export type LlmDebugSink = (entry: LlmDebugEntry) => void;

/**
 * Anything that watches the call's transcript stream (Phase 8, §8). The session
 * fans every transcript event out to a LIST of these instead of hardcoding
 * `this.conductor?.on*` per consumer: Phase 7's copilot conductor is consumer #1,
 * Phase 8's notes conductor #2, and Phase 9 gets it for free.
 *
 * Both handlers are optional — the notes conductor only wants finals, and
 * speculating on partials is a copilot-only concern. `dispose` is not: every
 * consumer owns session-scoped work (an in-flight model call, a timer) that must
 * stop exactly once, so each registers its own entry on the session's disposer.
 */
export interface LiveTranscriptConsumer {
  onPartial?(text: string, speaker: string | null): void;
  onFinal?(text: string, speaker: string | null): void;
  dispose(): void;
}

/** One flushed span of relayed audio attributed to the CURRENT stt vendor. */
export interface LiveSttUsage {
  readonly userId: string;
  readonly meetingId: string;
  readonly vendor: string;
  readonly seconds: number;
}

/**
 * Metering + quota seam the live session enforces spend through (Phase 6,
 * adr-0007 §3/§4). Kept live-local (not the metering module's own interface) so
 * this module stays an island; `metering-wiring.ts` adapts the real
 * MeteringService + QuotaChecker onto it. OPTIONAL everywhere it is consumed —
 * a keyless/DB-less dev boot skips enforcement exactly as it skips persistence
 * (the persister-optional posture): the session still streams to the phone,
 * just unmetered and unquota'd, because there is no ledger to meter into.
 *
 * `recordSttSeconds` follows the never-fail-the-metered-op law (the metering
 * service swallows persistence failures); the session still `.catch`es it so a
 * misbehaving seam cannot produce an unhandled rejection on the audio path.
 * `isOverSttQuota` resolves true when the caller is AT/OVER their plan's
 * stt-seconds budget for the rolling period.
 */
export interface LiveMetering {
  recordSttSeconds(usage: LiveSttUsage): Promise<void>;
  isOverSttQuota(userId: string): Promise<boolean>;
  /** true = the GLOBAL daily spend kill-switch is tripped (adr-0007 §5). */
  isOverDailyCap(): Promise<boolean>;
}

/**
 * ONE live session per user (Phase 6, adr-0007 §6) — the concurrency cap the
 * live WS gets instead of REST rate limiting. `acquire` is SYNCHRONOUS so two
 * simultaneous starts resolve deterministically (no async race window); the
 * session releases its slot exactly-once via its disposer. OPTIONAL in session
 * deps (the keyless posture).
 *
 * OPENER (logged, adr-0007 §6): this port's in-memory implementation is
 * single-instance by design — the deployment law today. A multi-instance
 * deploy needs a shared claim (alongside the RAG sweeper's same opener).
 */
export interface LiveSessionRegistry {
  /** Claim the user's single live-session slot; false = already held. */
  acquire(userId: string): boolean;
  /** Free the slot. Harmless no-op when not held. */
  release(userId: string): void;
}

/** The in-memory single-instance implementation (see the port's opener note). */
export function createInMemorySessionRegistry(): LiveSessionRegistry {
  const active = new Set<string>();
  return {
    acquire(userId: string): boolean {
      if (active.has(userId)) return false;
      active.add(userId);
      return true;
    },
    release(userId: string): void {
      active.delete(userId);
    },
  };
}

/** Build a fresh {@link Disposer}. */
export function createDisposer(): Disposer {
  const cleanups: (() => void)[] = [];
  let disposed = false;

  const runCleanup = (cleanup: () => void): void => {
    try {
      cleanup();
    } catch {
      // A failing cleanup must not abort the others; swallow (the transport
      // logs teardown failures at its own layer if it cares).
    }
  };

  return {
    add(cleanup) {
      if (disposed) {
        runCleanup(cleanup);
        return;
      }
      cleanups.push(cleanup);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // LIFO: unwind in reverse registration order, like nested resources.
      while (cleanups.length > 0) {
        const cleanup = cleanups.pop();
        if (cleanup) runCleanup(cleanup);
      }
    },
    get disposed() {
      return disposed;
    },
  };
}
