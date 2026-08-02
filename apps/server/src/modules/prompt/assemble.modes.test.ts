import { describe, expect, it } from "vitest";
import { liveModeSchema } from "@nova/shared";

import { assemble } from "./assemble.js";
import { SYSTEM_PROMPT } from "./library/index.js";
import type { PromptMode } from "./ports.js";

/**
 * [prompt-modes] Mode composition and, above all, mode LEAKAGE.
 *
 * The picker's promise is that a call gets one domain's rules. If a stray
 * directive from another mode rides along, the failure is silent and expensive:
 * the model still answers, just in the wrong shape, and nothing in the logs says
 * why. So each mode is checked positively (its own directive is present) AND
 * negatively (no other mode's directive or example response appears anywhere in
 * the assembled prompt).
 *
 * The markers below are chosen to be UNIQUE to their mode — verified by the
 * cross-product assertions themselves, which would fail on a shared phrase.
 */

/** The full text a vendor would see: cacheable prefix, then the per-turn suffix. */
function fullPrompt(mode: PromptMode): string {
  const { stablePrefix, dynamicSuffix } = assemble(mode, {
    transcript: [{ speaker: "them", text: "so what would you do here?" }],
  });
  return `${stablePrefix}\n\n${dynamicSuffix}`;
}

/** Distinctive strings from each mode's directive and its worked example. */
const MARKERS = {
  behavioral: {
    directive: "NEVER invent details about the user",
    example: "stuck alone with their piece",
  },
  technical: {
    directive: "If the question calls for CODE",
    example: "range-partition on time",
  },
  finance: {
    directive: "Structure the thinking with an established framework",
    example: "Pre-pay clears the ceiling",
  },
} as const;

const MODE_KEYS = Object.keys(MARKERS) as (keyof typeof MARKERS)[];

describe("modules/prompt [prompt-modes] the picked mode shapes the prefix", () => {
  it("[prompt-modes] general carries the system prompt and NO mode block", () => {
    const prompt = fullPrompt("general");
    expect(prompt).toContain(SYSTEM_PROMPT);
    for (const key of MODE_KEYS) {
      expect(prompt).not.toContain(MARKERS[key].directive);
      expect(prompt).not.toContain(MARKERS[key].example);
    }
  });

  it("[prompt-modes] every mode carries its OWN directive, structure and few-shot", () => {
    for (const key of MODE_KEYS) {
      const prompt = fullPrompt(key);
      expect(prompt).toContain(MARKERS[key].directive);
      expect(prompt).toContain(MARKERS[key].example);
      // The answer structure is what makes a mode a mode; a block that lost it
      // would still pass the directive check above.
      expect(prompt).toContain("ANSWER STRUCTURE");
    }
  });

  it("[prompt-modes] no mode leaks another mode's directive or example", () => {
    for (const key of MODE_KEYS) {
      const prompt = fullPrompt(key);
      for (const other of MODE_KEYS) {
        if (other === key) continue;
        expect(
          prompt,
          `${key} leaked ${other}'s directive`,
        ).not.toContain(MARKERS[other].directive);
        expect(
          prompt,
          `${key} leaked ${other}'s example response`,
        ).not.toContain(MARKERS[other].example);
      }
    }
  });

  it("[prompt-modes] every mode opens with the byte-identical system prompt", () => {
    // The mode composes ON TOP of the universal rules; it never edits them. Any
    // mode-specific rewording of the system prompt would be a second source of
    // truth for identity, format and the security rules — and `startsWith` (not
    // `contains`) is what pins the ORDER too: rules first, domain after.
    for (const mode of liveModeSchema.options) {
      const { stablePrefix } = assemble(mode, { transcript: [] });
      expect(
        stablePrefix.startsWith(SYSTEM_PROMPT),
        `${mode} does not open with the system prompt`,
      ).toBe(true);
      // The shared opening is the same LENGTH everywhere, so nothing was
      // trimmed or padded into it before the mode block begins.
      expect(stablePrefix.slice(0, SYSTEM_PROMPT.length)).toBe(SYSTEM_PROMPT);
    }
  });
});
