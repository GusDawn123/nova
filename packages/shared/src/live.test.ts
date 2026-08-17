import { describe, expect, it } from "vitest";

import {
  LIVE_PROTOCOL_VERSION,
  clientLiveEventSchema,
  liveModeSchema,
  parseClientEvent,
  serverLiveEventSchema,
  type ServerLiveEvent,
} from "./live.js";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const SUGGESTION_ID = "33333333-3333-4333-8333-333333333333";

/**
 * Representative accept + reject per event family (not exhaustive — the shape is
 * the contract, the union machinery is zod's). Every event carries `v: 1`.
 */
describe("clientLiveEventSchema", () => {
  it("accepts session.start with a uuid meeting_id (echo optional)", () => {
    const result = parseClientEvent({
      v: 1,
      type: "session.start",
      meeting_id: MEETING_ID,
      echo: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects session.start with a non-uuid meeting_id", () => {
    const result = parseClientEvent({
      v: 1,
      type: "session.start",
      meeting_id: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("accepts session.start carrying a picked mode (Phase 8.6)", () => {
    const result = parseClientEvent({
      v: 1,
      type: "session.start",
      meeting_id: MEETING_ID,
      mode: "technical",
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.type === "session.start").toBe(true);
    if (result.success && result.data.type === "session.start") {
      expect(result.data.mode).toBe("technical");
    }
  });

  it("treats an OMITTED mode as absent — an old client still starts", () => {
    // The field is additive on `v: 1`: a client built before the mode picker
    // sends no `mode`, and the server reads that as "general" on its side.
    const result = parseClientEvent({
      v: 1,
      type: "session.start",
      meeting_id: MEETING_ID,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "session.start") {
      expect(result.data.mode).toBeUndefined();
    }
  });

  it("rejects an unknown mode at the boundary (no silent fallback)", () => {
    // A bad mode must FAIL the parse — the server then answers `invalid_event`
    // rather than quietly serving general and hiding a client bug.
    expect(
      parseClientEvent({
        v: 1,
        type: "session.start",
        meeting_id: MEETING_ID,
        mode: "sales",
      }).success,
    ).toBe(false);
  });

  it("pins the mode vocabulary", () => {
    expect(liveModeSchema.options).toEqual([
      "general",
      "behavioral",
      "technical",
      "finance",
    ]);
  });

  it("accepts session.start with channels 1 or 2 (the desktop's stereo start)", () => {
    for (const channels of [1, 2]) {
      const result = parseClientEvent({
        v: 1,
        type: "session.start",
        meeting_id: MEETING_ID,
        channels,
      });
      expect(result.success).toBe(true);
    }
  });

  it("treats an OMITTED channels as absent — an old mono client still starts", () => {
    const result = parseClientEvent({
      v: 1,
      type: "session.start",
      meeting_id: MEETING_ID,
    });
    if (!result.success) throw new Error("expected success");
    if (result.data.type !== "session.start") throw new Error("wrong type");
    expect(result.data.channels).toBeUndefined();
  });

  it("rejects channels outside {1, 2} — numbers and strings alike", () => {
    for (const channels of [0, 3, -1, 1.5, "2", "stereo"]) {
      const result = parseClientEvent({
        v: 1,
        type: "session.start",
        meeting_id: MEETING_ID,
        channels,
      });
      expect(result.success).toBe(false);
    }
  });

  it("accepts the audio.frame marker, session.end and ping", () => {
    for (const type of ["audio.frame", "session.end", "ping"] as const) {
      expect(parseClientEvent({ v: 1, type }).success).toBe(true);
    }
  });

  it("accepts transcript.input with non-empty text (Phase 7 typed input)", () => {
    const result = parseClientEvent({
      v: 1,
      type: "transcript.input",
      text: "what did we quote them last time?",
    });
    expect(result.success).toBe(true);
  });

  it("accepts transcript.input with an explicit origin (Phase 8 fix)", () => {
    for (const origin of ["utterance", "copilot_question"]) {
      const result = parseClientEvent({
        v: 1,
        type: "transcript.input",
        text: "how should I price this?",
        origin,
      });
      expect(result.success).toBe(true);
    }
  });

  it("treats an OMITTED origin as absent (backward compatible)", () => {
    const result = parseClientEvent({
      v: 1,
      type: "transcript.input",
      text: "they said yes",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "transcript.input") {
      expect(result.data.origin).toBeUndefined();
    }
  });

  it("rejects an unknown transcript.input origin (closed set)", () => {
    const result = parseClientEvent({
      v: 1,
      type: "transcript.input",
      text: "hello there",
      origin: "whatever",
    });
    expect(result.success).toBe(false);
  });

  it("rejects transcript.input with empty or oversized text", () => {
    expect(
      parseClientEvent({ v: 1, type: "transcript.input", text: "" }).success,
    ).toBe(false);
    expect(
      parseClientEvent({
        v: 1,
        type: "transcript.input",
        text: "x".repeat(2001),
      }).success,
    ).toBe(false);
  });

  it("accepts suggest.now — the empty-handed Answer press (2026-08-17)", () => {
    expect(parseClientEvent({ v: 1, type: "suggest.now" }).success).toBe(true);
  });

  it("rejects suggest.now carrying a payload it does not define", () => {
    // Not `.strict()` — zod objects strip unknown keys — but text must not
    // sneak through as data: the parsed event carries only v + type.
    const result = parseClientEvent({
      v: 1,
      type: "suggest.now",
      text: "smuggled",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect("text" in result.data).toBe(false);
    }
  });

  it("rejects an unknown event type", () => {
    expect(parseClientEvent({ v: 1, type: "nope" }).success).toBe(false);
  });

  it("rejects a mismatched protocol version", () => {
    const result = parseClientEvent({ v: 2, type: "ping" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-object payload", () => {
    expect(clientLiveEventSchema.safeParse("ping").success).toBe(false);
  });

  it("pins the protocol version to 1", () => {
    expect(LIVE_PROTOCOL_VERSION).toBe(1);
  });
});

describe("serverLiveEventSchema", () => {
  const accepted: ServerLiveEvent[] = [
    { v: 1, type: "session.ready", session_id: SESSION_ID },
    { v: 1, type: "transcript.partial", text: "hi", speaker: null, ts_ms: 10 },
    {
      v: 1,
      type: "transcript.final",
      text: "hello",
      speaker: "A",
      ts_ms: 20,
      is_final: true,
    },
    { v: 1, type: "provider_switched", from: "assemblyai", to: "deepgram" },
    {
      v: 1,
      type: "suggestion.start",
      suggestion_id: SUGGESTION_ID,
      kind: "answer",
    },
    {
      v: 1,
      type: "suggestion.delta",
      suggestion_id: SUGGESTION_ID,
      text: "par",
    },
    {
      v: 1,
      type: "suggestion.done",
      suggestion_id: SUGGESTION_ID,
      text: "full",
    },
    {
      v: 1,
      type: "suggestion.discard",
      suggestion_id: SUGGESTION_ID,
      reason: "reconcile_miss",
    },
    { v: 1, type: "error", code: "invalid_json", message: "bad" },
    // Phase 6 enforcement codes (additive, no v bump): the app renders these as
    // paywall / blocked states.
    { v: 1, type: "error", code: "quota_exceeded", message: "over quota" },
    { v: 1, type: "error", code: "daily_cap_reached", message: "cap" },
    { v: 1, type: "error", code: "concurrent_session", message: "busy" },
    // Phase 7 (additive): typed input before session.start.
    { v: 1, type: "error", code: "input_before_start", message: "no session" },
    { v: 1, type: "pong" },
    { v: 1, type: "audio.echo", bytes: 640 },
  ];

  it.each(accepted)("accepts a valid %o", (event) => {
    expect(serverLiveEventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects transcript.final missing is_final", () => {
    const result = serverLiveEventSchema.safeParse({
      v: 1,
      type: "transcript.final",
      text: "hello",
      speaker: null,
      ts_ms: 20,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an error event with an unknown code", () => {
    const result = serverLiveEventSchema.safeParse({
      v: 1,
      type: "error",
      code: "kaboom",
      message: "x",
    });
    expect(result.success).toBe(false);
  });
});
