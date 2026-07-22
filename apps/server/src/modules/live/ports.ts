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
