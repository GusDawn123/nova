import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createLlmDebugLedger } from "./debug-transcript.js";
import type { LlmDebugEntry } from "./modules/live/ports.js";

/**
 * [debug-transcript] The dev-only answer ledger: hard-off without its env
 * flag (the production posture), one parseable JSONL line per entry when on.
 */

const ENTRY: LlmDebugEntry = {
  at: "2026-08-19T00:00:00.000Z",
  user_id: "user-1",
  meeting_id: "meeting-1",
  suggestion_id: "sug-1",
  trigger_text: "what is the price?",
  answer_text: "The price is $40 a seat, billed monthly.",
  outcome: "done",
  duration_ms: 850,
  input_tokens: 5000,
  cached_input_tokens: 4800,
};

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir !== null) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("debug-transcript (app wiring)", () => {
  it("is undefined when the flag is unset or empty (hard-off default)", () => {
    expect(createLlmDebugLedger({})).toBeUndefined();
    expect(createLlmDebugLedger({ LLM_DEBUG_TRANSCRIPT: "" })).toBeUndefined();
  });

  it("appends one parseable JSONL line per entry at the configured path", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "nova-ledger-"));
    const path = join(tempDir, "ledger.jsonl");
    const sink = createLlmDebugLedger({ LLM_DEBUG_TRANSCRIPT: path });
    expect(sink).toBeDefined();

    sink?.(ENTRY);
    sink?.({
      ...ENTRY,
      suggestion_id: "sug-2",
      outcome: "discard:no_response",
    });

    await vi.waitFor(() => {
      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0] ?? "")).toEqual(ENTRY);
      expect(JSON.parse(lines[1] ?? "")).toMatchObject({
        suggestion_id: "sug-2",
        outcome: "discard:no_response",
      });
    });
  });

  it("a failing write logs (ids only) and never throws into the caller", async () => {
    const error = vi.fn();
    // A path whose PARENT is a file cannot be created — the append must fail.
    tempDir = mkdtempSync(join(tmpdir(), "nova-ledger-"));
    const blocker = join(tempDir, "blocker");
    writeFileSync(blocker, "in the way", "utf8");
    const sink = createLlmDebugLedger(
      { LLM_DEBUG_TRANSCRIPT: join(blocker, "x", "ledger.jsonl") },
      { error },
    );

    expect(() => {
      sink?.(ENTRY);
    }).not.toThrow();
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]?.[1]).toBe(
        "live.debug_transcript_write_failed",
      );
    });
  });
});
