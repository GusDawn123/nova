import { describe, expect, it } from "vitest";
import { liveModeSchema } from "@nova/shared";

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

  it("speaks in the user's voice — the teleprompter register", () => {
    // The C++ failure (2026-08-01): asked "why should we hire you", the copilot
    // produced narration ABOUT the answer ("Addressing the C++ role effectively
    // requires demonstrating...") instead of words Gustavo could say. Two causes,
    // both here: the source doc's "No pronouns" rule forbade "I", and nothing
    // said the output is meant to be READ ALOUD.
    expect(SYSTEM_PROMPT).not.toMatch(/no pronouns/i);
    expect(SYSTEM_PROMPT).toContain("meta-phrases");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("first person");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("unsolicited advice");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("uncertainty");
  });

  it("lets a picked mode's structure refine the default shape", () => {
    // The default spoken shape must yield to a mode's own answer structure, or
    // mode-specific shapes (a code block, a story) get squeezed back out.
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("mode");
  });

  it("defaults to spoken prose, not a card (2026-08-01 reference study)", () => {
    // The source doc's "Short headline (<=6 words) / 1-2 main bullets" card is a
    // dashboard. A dashboard cannot be read aloud, so it fought THE REGISTER on
    // every answer. The default shape is now first-person prose with sparing
    // key-term bold as the scanning aid.
    expect(SYSTEM_PROMPT).not.toContain("Short headline");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("prose");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("aloud");
    // Bold survives as the one visual aid precisely because it is never spoken.
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("never spoken");
  });

  it("bans the em dash and semicolon in spoken lines", () => {
    // The em dash is the loudest written-register tell in speech; a person says
    // a comma or a full stop. Scoped to spoken lines — code/math/notes exempt.
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("em dash");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("semicolon");
  });

  it("carries a spoken length law", () => {
    // Correct-but-unsayable is still a failure: a 150-word paragraph cannot be
    // delivered seconds after it streams in. Default 15-30 seconds, shortest
    // that fully answers; code and notes exempt.
    expect(SYSTEM_PROMPT).toContain("15-30 seconds");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("shortest");
  });

  it("bans coaching labels from the output", () => {
    // "**Objection: [Name]**" is a tag the user cannot say out loud. The label
    // moved into speakable words (an acknowledgment opener, then the reframe).
    expect(SYSTEM_PROMPT).not.toContain("**Objection: [Generic Objection Name]**");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("coaching tags");
  });

  it("uses context silently and admits gaps in a speakable first person", () => {
    // Two failure modes with one root: narrating the source ("based on your
    // notes...") and narrating the absence ("I don't have information about
    // that"). Both break the teleprompter frame; both get speakable shapes.
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("silently");
    expect(SYSTEM_PROMPT).toContain("based on your notes");
  });

  it("keeps the FINAL CHECK last, where it weighs the most", () => {
    // Recency anchoring: the instruction closest to the output carries the most
    // weight, and these checks (invented numbers, unspeakable lines) are the
    // ones that erase an answer's value. Position is part of the design.
    const idx = SYSTEM_PROMPT.indexOf("FINAL CHECK");
    expect(idx).toBeGreaterThan(0);
    expect(SYSTEM_PROMPT.length - idx).toBeLessThan(600);
  });

  it("is anchored in the LIVE moment, and sounds like a person", () => {
    // Second field report (2026-08-01): first person now, but press-release
    // first person — "too direct". The public pattern for this class of tool is
    // concrete voice mechanics, not "be casual": spoken rhythm, contractions,
    // a named blacklist of machine-tell words.
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("real time");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("contraction");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("across a table");
    // The machine-tell blacklist exists and names the usual suspects.
    expect(SYSTEM_PROMPT).toContain('"leverage"');
    expect(SYSTEM_PROMPT).toContain('"delve"');
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

  it("cannot drift from the wire enum the picker sends", () => {
    // The two halves of one contract: the phone sends a `liveModeSchema` value on
    // `session.start`, and this library is what answers with. "general" is the
    // system prompt ALONE — a mode on the wire with deliberately no block here —
    // so it is the one value that must not have a library entry.
    const wireModes = liveModeSchema.options.filter((m) => m !== "general");
    expect(Object.keys(MODES).sort()).toEqual([...wireModes].sort());
  });

  it("gives every mode picker text", () => {
    for (const mode of Object.values(MODES)) {
      expect(mode.label.length).toBeGreaterThan(0);
      expect(mode.useWhen.length).toBeGreaterThan(0);
    }
  });

  it("behavioral answers ARE the answer — first person, speakable", () => {
    // Every behavioral example must be words the user can read aloud as their
    // own. An example that talks ABOUT the answer would teach the narration
    // failure right back into the mode.
    for (const example of MODES.behavioral.examples) {
      expect(example.response.slice(0, 200)).toMatch(/\bI\b/);
      expect(example.response).not.toMatch(/requires demonstrating/i);
    }
    expect(MODES.behavioral.directive.toLowerCase()).toContain("first person");
  });

  it("few-shots model the spoken register they ship beside — no em dashes", () => {
    // The system prompt bans the em dash in spoken lines. An example that uses
    // one teaches against the rule it travels with, and the model believes the
    // demonstration over the instruction every time. Code fences are exempt
    // (code is used, not spoken), so they are stripped before the check.
    for (const mode of Object.values(MODES)) {
      for (const example of mode.examples) {
        const spoken = example.response.replace(/```[\s\S]*?```/g, " ");
        expect(spoken).not.toContain("—"); // —
        expect(spoken).not.toContain("–"); // –
      }
    }
  });

  it("gives every mode a voice anchor", () => {
    // One line of WHO is speaking. A shape without a speaker drifts back into
    // assistant-voice under pressure; the anchor is what it snaps back to.
    for (const mode of Object.values(MODES)) {
      expect(mode.directive).toContain("Voice anchor:");
    }
  });
});

describe("live notes", () => {
  it("is a category, not a mode", () => {
    expect(Object.keys(MODES)).not.toContain(LIVE_NOTES_CATEGORY.id);
    expect(LIVE_NOTES_CATEGORY.notAMode.length).toBeGreaterThan(0);
  });

  it("never catches the spoken voice — its output is a document", () => {
    // The inverse of the register tests: notes are read later, not said now.
    // If the spoken rules (first person, say-it-aloud) leak into the notes
    // prompt, the notes start sounding like a person instead of a record. The
    // two registers must stay separable by construction.
    const notesText =
      `${LIVE_NOTES_CATEGORY.directive}\n${LIVE_NOTES_CATEGORY.answerStructure}`.toLowerCase();
    expect(notesText).not.toContain("first person");
    expect(notesText).not.toContain("aloud");
    expect(notesText).not.toContain("across a table");
    expect(notesText).not.toContain("voice anchor");
  });
});
