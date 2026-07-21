import { describe, expect, it } from "vitest";

import { SttAuthError, SttProtocolError, SttTransientError } from "../ports.js";
import { mapAssemblyAiError, translateTurn } from "./assemblyai.js";

describe("translateTurn", () => {
  it("maps an in-progress turn (end_of_turn=false) to a partial", () => {
    const event = translateTurn({
      type: "Turn",
      end_of_turn: false,
      transcript: "hello there",
      words: [{ start: 1200, end: 1400, confidence: 0.9, text: "hello" }],
    });
    expect(event).toEqual({
      type: "partial",
      text: "hello there",
      speaker: null,
      ts_ms: 1200,
    });
  });

  it("maps a committed turn (end_of_turn=true) to a final", () => {
    const event = translateTurn({
      type: "Turn",
      end_of_turn: true,
      transcript: "how can I help?",
      speaker_label: "A",
      words: [{ start: 2500, end: 2700, confidence: 0.95, text: "how", speaker: "A" }],
    });
    expect(event).toEqual({
      type: "final",
      text: "how can I help?",
      speaker: "A",
      ts_ms: 2500,
    });
  });

  it("prefers turn-level speaker_label, falling back to the first word's speaker", () => {
    const fromWord = translateTurn({
      end_of_turn: true,
      transcript: "yes",
      words: [{ start: 10, speaker: "B" }],
    });
    expect(fromWord).toMatchObject({ speaker: "B" });
  });

  it("returns null for an empty transcript (a silent interim worth dropping)", () => {
    expect(
      translateTurn({ end_of_turn: false, transcript: "   ", words: [] }),
    ).toBeNull();
  });

  it("returns a protocol error event when the payload breaks the schema", () => {
    const event = translateTurn({ end_of_turn: "nope", transcript: 5 });
    expect(event).not.toBeNull();
    if (event?.type !== "error") throw new Error("expected error event");
    expect(event.error).toBeInstanceOf(SttProtocolError);
  });

  it("defaults ts_ms to 0 when a turn has no words", () => {
    expect(translateTurn({ end_of_turn: true, transcript: "ok" })).toMatchObject({
      ts_ms: 0,
      speaker: null,
    });
  });
});

describe("mapAssemblyAiError", () => {
  it("maps auth failures to SttAuthError", () => {
    expect(mapAssemblyAiError(new Error("Unauthorized"))).toBeInstanceOf(SttAuthError);
  });

  it("maps unknown failures to SttTransientError with a vendor prefix", () => {
    const mapped = mapAssemblyAiError(new Error("connection reset"));
    expect(mapped).toBeInstanceOf(SttTransientError);
    expect(mapped.message).toBe("assemblyai: connection reset");
  });
});
