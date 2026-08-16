import { describe, expect, it, vi } from "vitest";

import { SttAuthError, SttProtocolError, SttTransientError } from "../ports.js";
import {
  createDeepgramVendor,
  mapDeepgramError,
  translateResults,
} from "./deepgram.js";

/**
 * A stand-in for the SDK's live socket: `connect()` fires "open" immediately so
 * the adapter's open-handshake resolves, and every option object handed to
 * `listen.v1.connect` is captured for assertion.
 */
const dg = vi.hoisted(() => {
  const connectOptions: Record<string, unknown>[] = [];
  function makeFakeSocket() {
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    return {
      on(event: string, handler: (...args: unknown[]) => void) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      connect() {
        for (const handler of handlers.get("open") ?? []) handler();
      },
      sendMedia() {
        /* not exercised */
      },
      sendCloseStream() {
        /* not exercised */
      },
      close() {
        /* not exercised */
      },
    };
  }
  class DeepgramClient {
    listen = {
      v1: {
        connect: (options: Record<string, unknown>) => {
          connectOptions.push(options);
          return Promise.resolve(makeFakeSocket());
        },
      },
    };
  }
  return { connectOptions, DeepgramClient };
});

vi.mock("@deepgram/sdk", () => ({ DeepgramClient: dg.DeepgramClient }));

/** Build a minimal Deepgram `Results` message. */
function results(opts: {
  transcript: string;
  isFinal?: boolean;
  start?: number;
  speaker?: number;
  channelIndex?: number;
}): unknown {
  return {
    type: "Results",
    is_final: opts.isFinal ?? false,
    start: opts.start ?? 0,
    ...(opts.channelIndex === undefined
      ? {}
      : { channel_index: [opts.channelIndex, 2] }),
    channel: {
      alternatives: [
        {
          transcript: opts.transcript,
          confidence: 0.9,
          words:
            opts.speaker === undefined
              ? []
              : [
                  {
                    word: "hi",
                    start: 0,
                    end: 0.2,
                    confidence: 0.9,
                    speaker: opts.speaker,
                  },
                ],
        },
      ],
    },
    metadata: { request_id: "x", model_uuid: "y", model_info: {} },
  };
}

describe("translateResults", () => {
  it("maps a non-final Results to a partial with ts_ms in milliseconds", () => {
    const event = translateResults(
      results({ transcript: "hello", start: 1.25 }),
    );
    expect(event).toEqual({
      type: "partial",
      text: "hello",
      speaker: null,
      ts_ms: 1250,
    });
  });

  it("maps a final Results and stringifies the speaker number", () => {
    const event = translateResults(
      results({ transcript: "goodbye", isFinal: true, start: 3, speaker: 1 }),
    );
    expect(event).toEqual({
      type: "final",
      text: "goodbye",
      speaker: "1",
      ts_ms: 3000,
    });
  });

  it("preserves speaker 0 (does not confuse it with 'no speaker')", () => {
    expect(
      translateResults(results({ transcript: "yes", speaker: 0 })),
    ).toMatchObject({ speaker: "0" });
  });

  it("labels stereo channels as me/them — the channel IS the speaker", () => {
    expect(
      translateResults(results({ transcript: "hi", channelIndex: 0 }), 2),
    ).toMatchObject({ speaker: "me" });
    expect(
      translateResults(results({ transcript: "hey", channelIndex: 1 }), 2),
    ).toMatchObject({ speaker: "them" });
  });

  it("ignores diarized speaker numbers in the stereo case", () => {
    // A stray per-word speaker number must never override the channel label.
    const event = translateResults(
      results({ transcript: "hi", channelIndex: 1, speaker: 0 }),
      2,
    );
    expect(event).toMatchObject({ speaker: "them" });
  });

  it("falls back to a null speaker when a stereo Results omits channel_index", () => {
    expect(translateResults(results({ transcript: "hi" }), 2)).toMatchObject({
      speaker: null,
    });
  });

  it("rejects an impossible stereo channel index as a protocol error", () => {
    // channel_index [2, 2] has no me/them meaning; guessing "them" would
    // mislabel who said what, which is worse than failing loudly.
    const event = translateResults(
      results({ transcript: "hi", channelIndex: 2 }),
      2,
    );
    if (event?.type !== "error") throw new Error("expected error event");
    expect(event.error).toBeInstanceOf(SttProtocolError);
  });

  it("ignores non-Results messages (Metadata / UtteranceEnd / SpeechStarted)", () => {
    expect(translateResults({ type: "Metadata", request_id: "z" })).toBeNull();
    expect(
      translateResults({ type: "UtteranceEnd", last_word_end: 4 }),
    ).toBeNull();
    expect(translateResults({ type: "SpeechStarted" })).toBeNull();
  });

  it("returns null for an empty transcript", () => {
    expect(translateResults(results({ transcript: "  " }))).toBeNull();
  });

  it("returns a protocol error event when a Results payload breaks the schema", () => {
    const event = translateResults({
      type: "Results",
      start: "soon",
      channel: {},
    });
    if (event?.type !== "error") throw new Error("expected error event");
    expect(event.error).toBeInstanceOf(SttProtocolError);
  });
});

describe("createDeepgramVendor.connect", () => {
  it("requests multichannel with diarize OFF for a stereo session", async () => {
    const vendor = createDeepgramVendor({ apiKey: "key" });
    const connection = await vendor.connect(
      { sessionId: "s1", sampleRateHz: 16000, channels: 2 },
      new AbortController().signal,
    );
    expect(dg.connectOptions.at(-1)).toMatchObject({
      channels: 2,
      multichannel: "true",
      diarize: "false",
    });
    connection.abort();
  });

  it("keeps mono diarized, with no multichannel flag", async () => {
    const vendor = createDeepgramVendor({ apiKey: "key" });
    const connection = await vendor.connect(
      { sessionId: "s2", sampleRateHz: 16000 },
      new AbortController().signal,
    );
    const options = dg.connectOptions.at(-1);
    expect(options).toMatchObject({ channels: 1, diarize: "true" });
    expect(options).not.toHaveProperty("multichannel");
    connection.abort();
  });
});

describe("mapDeepgramError", () => {
  it("maps auth failures to SttAuthError", () => {
    expect(mapDeepgramError(new Error("invalid api key"))).toBeInstanceOf(
      SttAuthError,
    );
  });

  it("maps unknown failures to SttTransientError with a vendor prefix", () => {
    const mapped = mapDeepgramError(new Error("network down"));
    expect(mapped).toBeInstanceOf(SttTransientError);
    expect(mapped.message).toBe("deepgram: network down");
  });
});
