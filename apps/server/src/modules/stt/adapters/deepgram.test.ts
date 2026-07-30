import { describe, expect, it } from "vitest";

import { SttAuthError, SttProtocolError, SttTransientError } from "../ports.js";
import { mapDeepgramError, translateResults } from "./deepgram.js";

/** Build a minimal Deepgram `Results` message. */
function results(opts: {
  transcript: string;
  isFinal?: boolean;
  start?: number;
  speaker?: number;
}): unknown {
  return {
    type: "Results",
    is_final: opts.isFinal ?? false,
    start: opts.start ?? 0,
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
