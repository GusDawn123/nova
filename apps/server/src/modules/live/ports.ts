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
