import { DeepgramClient } from "@deepgram/sdk";
import { z } from "zod";

import {
  SttError,
  SttProtocolError,
  SttTransientError,
  type SttSessionInfo,
  type SttVendor,
  type SttVendorConnection,
  type SttVendorEvent,
} from "../ports.js";
import {
  AsyncEventQueue,
  VendorStreamConnection,
  raceTimeout,
} from "./stream-bridge.js";
import { toSttError } from "./vendor-errors.js";

/**
 * Deepgram live-streaming adapter (Phase 3.5) — the FALLBACK vendor. The only
 * place the `@deepgram/sdk` is imported (RULES §5). THIN: open the socket
 * (pre-warm), translate each `Results` message to a {@link SttVendorEvent}, relay
 * PCM up, map failures to typed {@link SttError}s. No disk.
 *
 * SDK: `@deepgram/sdk` v5, `listen.v1.connect`. Options (design doc §modules/stt):
 *   - `model: "nova-3"`, `language: "en"`.
 *   - `encoding: "linear16"`, `sample_rate` from the session (16 kHz PCM16 mono).
 *   - `interim_results: "true"` — interim hypotheses while streaming.
 *   - `diarize: "true"` — per-word speaker numbers from the single mic feed.
 *   - `endpointing: 300` — ~300ms silence to finalize (design doc).
 *   - `punctuate: "true"` — punctuation/casing.
 * (v5 quirk: boolean options are passed as the STRINGS "true"/"false".) A
 * `Results` message with `is_final: false` is a partial; `true` is a final.
 * `reconnectAttempts: 0` keeps a dead socket from silently retrying 30×, so the
 * engine — not the SDK — owns reconnect/failover.
 */

// ---------------------------------------------------------------------------
// Vendor payload schema (zod-parsed — RULES: parse every boundary)
// ---------------------------------------------------------------------------

/**
 * The subset of Deepgram's `Results` message we rely on. `start` is audio-time
 * SECONDS; `words[i].speaker` is a 0-based speaker number (present only when
 * `diarize` is on). Non-`Results` messages (Metadata / UtteranceEnd /
 * SpeechStarted) are ignored upstream.
 */
const resultsSchema = z.object({
  type: z.literal("Results"),
  is_final: z.boolean().optional(),
  start: z.number(),
  channel: z.object({
    alternatives: z.array(
      z.object({
        transcript: z.string(),
        words: z
          .array(
            z.object({
              speaker: z.number().optional(),
            }),
          )
          .optional(),
      }),
    ),
  }),
});

/**
 * Translate one raw Deepgram message into a vendor event.
 * - Returns `null` for a non-`Results` message or an empty transcript.
 * - Returns an `error` event (protocol) when a `Results` payload breaks schema.
 * Exported for direct unit testing (no network needed).
 */
export function translateResults(raw: unknown): SttVendorEvent | null {
  // Cheap discriminant read first: ignore Metadata/UtteranceEnd/SpeechStarted.
  const envelope = z.object({ type: z.string() }).safeParse(raw);
  if (!envelope.success || envelope.data.type !== "Results") return null;

  const parsed = resultsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      type: "error",
      error: new SttProtocolError(
        `deepgram: unparseable Results payload — ${parsed.error.message}`,
      ),
    };
  }
  const data = parsed.data;
  const alternative = data.channel.alternatives[0];
  const transcript = alternative?.transcript ?? "";
  if (transcript.trim() === "") return null;

  const speakerNumber = alternative?.words?.[0]?.speaker;
  const speaker = speakerNumber === undefined ? null : String(speakerNumber);

  return {
    type: data.is_final === true ? "final" : "partial",
    text: transcript,
    speaker,
    ts_ms: Math.round(data.start * 1000),
  };
}

/** Map any Deepgram SDK error to a typed {@link SttError} (never leaked raw). */
export function mapDeepgramError(err: unknown): SttError {
  return toSttError("deepgram", err);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Construction options for the Deepgram vendor. `apiKey` is required. */
export interface DeepgramVendorOptions {
  readonly apiKey: string;
  /** Override the API base URL (custom/self-hosted). Production leaves this unset. */
  readonly baseUrl?: string;
  /** Model. Default "nova-3". */
  readonly model?: string;
  /** Language hint. Default "en". */
  readonly language?: string;
  /** ~endpointing: silence (ms) before finalizing. Default 300 (design doc). */
  readonly endpointingMs?: number;
  /** Per-word diarization. Default true. */
  readonly diarize?: boolean;
}

/** Deepgram's WebSocket boolean options are the strings "true"/"false" in v5. */
function boolFlag(value: boolean): "true" | "false" {
  return value ? "true" : "false";
}

/**
 * How long a graceful `end()` waits for Deepgram to acknowledge CloseStream
 * (flush finals + close the socket) before falling through to abort-style
 * teardown. 2s is generous for a flush yet keeps session teardown bounded.
 */
const GRACEFUL_CLOSE_TIMEOUT_MS = 2000;

/**
 * Build the Deepgram {@link SttVendor}. `connect` pre-warms a live socket,
 * resolving only once it opens (or rejecting with a typed error / on abort /
 * on a pre-open close).
 */
export function createDeepgramVendor(opts: DeepgramVendorOptions): SttVendor {
  const client = new DeepgramClient({
    apiKey: opts.apiKey,
    ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
  });

  return {
    id: "deepgram",
    async connect(
      info: SttSessionInfo,
      signal: AbortSignal,
    ): Promise<SttVendorConnection> {
      if (signal.aborted) {
        throw new SttTransientError("deepgram: aborted before connect");
      }

      // `.catch` (never-returning) maps any SDK rejection to a typed error so no
      // raw SDK error leaks out of the adapter (RULES §5), without a `let`.
      const socket = await client.listen.v1
        .connect({
          Authorization: `Token ${opts.apiKey}`,
          model: opts.model ?? "nova-3",
          language: opts.language ?? "en",
          encoding: "linear16",
          sample_rate: info.sampleRateHz,
          channels: 1,
          interim_results: "true",
          punctuate: "true",
          diarize: boolFlag(opts.diarize ?? true),
          endpointing: opts.endpointingMs ?? 300,
          reconnectAttempts: 0,
          abortSignal: signal,
        })
        .catch((err: unknown): never => {
          throw mapDeepgramError(err);
        });

      const queue = new AsyncEventQueue<SttVendorEvent>();
      let opened = false;
      let settleOpen: (() => void) | null = null;
      let failOpen: ((err: SttError) => void) | null = null;
      const openPromise = new Promise<void>((resolve, reject) => {
        settleOpen = resolve;
        failOpen = reject;
      });

      socket.on("open", () => {
        opened = true;
        settleOpen?.();
      });
      socket.on("message", (message) => {
        const event = translateResults(message);
        if (event) queue.push(event);
      });
      socket.on("error", (err) => {
        const mapped = mapDeepgramError(err);
        if (opened) queue.push({ type: "error", error: mapped });
        else failOpen?.(mapped);
      });
      socket.on("close", (event) => {
        if (opened) {
          queue.close();
        } else {
          failOpen?.(
            toSttError("deepgram", `socket closed (${String(event.code)})`, event.code),
          );
        }
      });

      const onAbort = (): void => {
        failOpen?.(new SttTransientError("deepgram: connect aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });

      socket.connect();
      try {
        await openPromise;
      } catch (err) {
        socket.close();
        queue.close();
        throw err instanceof SttError ? err : mapDeepgramError(err);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }

      return new VendorStreamConnection(queue, {
        sendAudio: (frame) => {
          socket.sendMedia(frame);
        },
        end: async () => {
          // Tell Deepgram no more audio; it flushes finals then closes, which
          // fires "close" → queue.close(). Await the close to drain finals — but
          // BOUNDED: a vendor that never acknowledges CloseStream must not hang
          // end() forever, so past the timeout fall through to abort-style teardown.
          const closed = new Promise<void>((resolve) => {
            socket.on("close", () => {
              queue.close();
              resolve();
            });
          });
          socket.sendCloseStream({ type: "CloseStream" });
          const timedOut = await raceTimeout(closed, GRACEFUL_CLOSE_TIMEOUT_MS);
          if (timedOut) {
            socket.close();
            queue.close();
          }
        },
        abort: () => {
          socket.close();
          queue.close();
        },
      });
    },
  };
}
