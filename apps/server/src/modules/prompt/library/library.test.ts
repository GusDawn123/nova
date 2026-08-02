import { describe, expect, it } from "vitest";

import { LIVE_NOTES_CATEGORY, MODES, SYSTEM_PROMPT } from "./index.js";

/**
 * Structural guarantees for the prompt library.
 *
 * These do not judge whether a prompt is GOOD — only a live gate against a real
 * model can do that. They pin the things that can silently rot: a mode that lost
 * its answer structure, few-shot that drifted into the system prompt, or a
 * capability claim we cannot honour.
 */

describe("system prompt", () => {
  it("never claims Nova can see the user's screen", () => {
    // The source document opens with "You can see the user's screen (the
    // screenshot attached)". Nova has no screen capture and never sends one, so
    // shipping that sentence tells the model it has an input it will never get.
    expect(SYSTEM_PROMPT.toLowerCase()).not.toContain("see the user's screen");
    expect(SYSTEM_PROMPT.toLowerCase()).not.toContain("screenshot");
  });

  it("carries the rules that apply no matter which mode is picked", () => {
    expect(SYSTEM_PROMPT).toContain("me");
    expect(SYSTEM_PROMPT).toContain("them");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("objection");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("follow-up");
  });

  it("holds no few-shot examples", () => {
    // Examples belong to the mode that needs them. A transcript sample in the
    // always-on prefix is paid for on every call in every mode.
    expect(SYSTEM_PROMPT).not.toContain("<transcript_sample>");
  });
});

describe("modes", () => {
  it("exposes the modes that are built", () => {
    expect(Object.keys(MODES).sort()).toEqual([
      "behavioral",
      "finance",
      "technical",
    ]);
  });

  it("gives every mode an answer structure — that is what makes it a mode", () => {
    for (const mode of Object.values(MODES)) {
      expect(mode.answerStructure.trim().length).toBeGreaterThan(0);
    }
  });

  it("gives every mode at least one worked example", () => {
    // A directive without a demonstration is the thin state the source document
    // left technical and finance in; both were filled in rather than shipped bare.
    for (const mode of Object.values(MODES)) {
      expect(mode.examples.length).toBeGreaterThan(0);
    }
  });

  it("keeps ids in sync with their keys, since the id rides the wire", () => {
    for (const [key, mode] of Object.entries(MODES)) {
      expect(mode.id).toBe(key);
    }
  });

  it("gives every mode picker text", () => {
    for (const mode of Object.values(MODES)) {
      expect(mode.label.length).toBeGreaterThan(0);
      expect(mode.useWhen.length).toBeGreaterThan(0);
    }
  });
});

describe("live notes", () => {
  it("is a category, not a mode", () => {
    expect(Object.keys(MODES)).not.toContain(LIVE_NOTES_CATEGORY.id);
    expect(LIVE_NOTES_CATEGORY.notAMode.length).toBeGreaterThan(0);
  });
});
