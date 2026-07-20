import { StreamingTranscriber } from "assemblyai";
import { z } from "zod";

import {
  SttProtocolError,
  SttTransientError,
  type SttError,
  type SttSessionInfo,
  type SttVendor,
  type SttVendorConnection,
  type SttVendorEvent,
} from "../ports.js";
import {
  AsyncEventQueue,
  VendorStreamConnection,
} from "./stream-bridge.js";
import { toSttError } from "./vendor-errors.js";

/**
 * AssemblyAI Universal-Streaming adapter (Phase 3.5) — the PRIMARY vendor. This
 * is the only place the `assemblyai` SDK is imported (RULES §5). It is THIN:
 * open the streaming socket (pre-warm seam), translate each `Turn` message into a
 * {@link SttVendorEvent}, relay PCM up, and map every failure to a typed
 * {@link SttError}. No disk, no state beyond the live socket.
 *
 * SDK: `assemblyai` v4, `StreamingTranscriber` (`wss://streaming.assemblyai.com
 * /v3/ws`, model `u3-rt-pro`). Options (design doc §modules/stt):
 *   - `sampleRate` from the session (16 kHz), `encoding: "pcm_s16le"` (PCM16 mono).
 *   - `formatTurns: true` — punctuation/casing on committed turns.
 *   - `speakerLabels: true` — diarization from the single mixed mic feed.
 *   - `includePartialTurns: true` — interim hypotheses stream as the turn builds.
 *   - `minTurnSilence: 300` — ~300ms endpointing tuned for conversation.
 * A `Turn` with `end_of_turn: false` is a partial; `true` is a committed final.
 */

// ---------------------------------------------------------------------------
// Vendor payload schema (zod-parsed — RULES: parse every boundary)
// ---------------------------------------------------------------------------

/**
 * The subset of AssemblyAI's `TurnEvent` we rely on. Unknown keys are ignored;
 * the fields below are the contract we translate. `words[i].start` is audio-time
 * milliseconds; `speaker` (and the turn-level `speaker_label`) appear only when
 * `speakerLabels` is enabled.
 */
const turnSchema = z.object({
  transcript: z.string(),
  end_of_turn: z.boolean(),
  speaker_label: z.string().optional(),
  words: z
    .array(
      z.object({
        start: z.number(),
        speaker: z.string().optional(),
      }),
    )
    .optional(),
});

/**
 * Translate one raw AssemblyAI `Turn` payload into a vendor event.
 * - Returns `null` for an empty transcript (a silent interim worth dropping).
 * - Returns an `error` event (protocol) when the payload breaks the schema —
 *   the engine surfaces that distinctly rather than crashing on a bad frame.
 * Exported for direct unit testing (no network needed).
 */
export function translateTurn(raw: unknown): SttVendorEvent | null {
  const parsed = turnSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      type: "error",
      error: new SttProtocolError(
        `assemblyai: unparseable turn payload — ${parsed.error.message}`,
      ),
    };
  }
  const turn = parsed.data;
  if (turn.transcript.trim() === "") return null;

  const firstWord = turn.words?.[0];
  const speaker = turn.speaker_label ?? firstWord?.speaker ?? null;
  const ts_ms = firstWord?.start ?? 0;

  return {
    type: turn.end_of_turn ? "final" : "partial",
    text: turn.transcript,
    speaker,
    ts_ms,
  };
}

/** Map any AssemblyAI SDK error to a typed {@link SttError} (never leaked raw). */
export function mapAssemblyAiError(err: unknown): SttError {
  return toSttError("assemblyai", err);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Construction options for the AssemblyAI vendor. `apiKey` is required. */
export interface AssemblyAiVendorOptions {
  readonly apiKey: string;
  /**
   * Override the streaming WebSocket base URL. Production leaves this unset
   * (SDK default); the failover accuracy test points the primary at a dead URL
   * to force a switch to Deepgram.
   */
  readonly websocketBaseUrl?: string;
  /** ~endpointing: min silence (ms) before a turn ends. Default 300 (design doc). */
  readonly minTurnSilenceMs?: number;
  /** Diarization/speaker labels. Default true. */
  readonly speakerLabels?: boolean;
  /** Punctuation + casing on committed turns. Default true. */
  readonly formatTurns?: boolean;
}

/** Reject once `signal` aborts; used to race a slow connect against teardown. */
function rejectOnAbort(signal: AbortSignal): {
  promise: Promise<never>;
  cancel: () => void;
} {
  let onAbort!: () => void;
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(new SttTransientError("assemblyai: connect aborted"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  // Swallow the loser of the race so it never becomes an unhandled rejection.
  promise.catch(() => undefined);
  return {
    promise,
    cancel: () => {
      signal.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Build the AssemblyAI {@link SttVendor}. `connect` pre-warms a live streaming
 * socket, resolving only once the server's `Begin` handshake completes (or
 * rejecting with a typed error / on abort).
 */
export function createAssemblyAiVendor(
  opts: AssemblyAiVendorOptions,
): SttVendor {
  return {
    id: "assemblyai",
    async connect(
      info: SttSessionInfo,
      signal: AbortSignal,
    ): Promise<SttVendorConnection> {
      if (signal.aborted) {
        throw new SttTransientError("assemblyai: aborted before connect");
      }

      const transcriber = new StreamingTranscriber({
        apiKey: opts.apiKey,
        sampleRate: info.sampleRateHz,
        encoding: "pcm_s16le",
        speechModel: "u3-rt-pro",
        formatTurns: opts.formatTurns ?? true,
        speakerLabels: opts.speakerLabels ?? true,
        includePartialTurns: true,
        minTurnSilence: opts.minTurnSilenceMs ?? 300,
        ...(opts.websocketBaseUrl !== undefined
          ? { websocketBaseUrl: opts.websocketBaseUrl }
          : {}),
      });

      const queue = new AsyncEventQueue<SttVendorEvent>();
      transcriber.on("turn", (turn) => {
        const event = translateTurn(turn);
        if (event) queue.push(event);
      });
      transcriber.on("error", (err) => {
        queue.push({ type: "error", error: mapAssemblyAiError(err) });
      });
      transcriber.on("close", () => {
        queue.close();
      });

      const abortRace = rejectOnAbort(signal);
      // Attach a no-op catch so that, if the abort wins the race, the losing
      // connect promise rejecting later never becomes an unhandled rejection.
      const connectPromise = transcriber.connect();
      connectPromise.catch(() => undefined);
      try {
        await Promise.race([connectPromise, abortRace.promise]);
      } catch (err) {
        void transcriber.close(false).catch(() => undefined);
        queue.close();
        throw mapAssemblyAiError(err);
      } finally {
        abortRace.cancel();
      }

      return new VendorStreamConnection(queue, {
        sendAudio: (frame) => {
          // AssemblyAI's `sendAudio` wants an ArrayBuffer; a Node Buffer is a
          // view over a (possibly pooled) ArrayBuffer, so slice out exactly this
          // frame's bytes.
          transcriber.sendAudio(
            frame.buffer.slice(
              frame.byteOffset,
              frame.byteOffset + frame.byteLength,
            ),
          );
        },
        end: async () => {
          // `close(true)` waits for the server to flush finals + terminate.
          await transcriber.close(true);
          queue.close();
        },
        abort: () => {
          void transcriber.close(false).catch(() => undefined);
          queue.close();
        },
      });
    },
  };
}
