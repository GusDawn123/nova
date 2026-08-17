import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BRAIN_A_MEETING_PROMPT } from "./content/meeting-enterprise.js";
import { BRAIN_B_SOLVER_PROMPT } from "./content/problem-solver.js";
import { assembleMeeting, assembleSolver } from "./two-brain.js";

/**
 * [prompt-snapshot] Prompt fidelity for the two brains (proof gate 8): each
 * generated constant is BYTE-FOR-BYTE the authored source doc, and each
 * assembler's stablePrefix is byte-identical to its constant on every call
 * (the vendor prompt cache keys on an exact prefix match — adr-0004 §6).
 *
 * A red test here means either the source doc changed (regenerate with
 * `scripts/gen-brain-prompts.mjs` — a deliberate decision that re-runs the
 * live gates) or code touched prose it must never touch (RULES §9).
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");

/**
 * The generator's extraction rule, re-applied independently: the prompt body
 * starts at the first `<core_identity>` tag (mechanically skipping the banner
 * comment and doc furniture), CRLF-normalized, one trailing newline. Kept in
 * lockstep with `extractPromptBody` in `scripts/gen-brain-prompts.mjs`.
 */
function extractPromptBody(source: string): string {
  const start = source.indexOf("<core_identity>");
  if (start === -1) throw new Error("no <core_identity> tag in source doc");
  return source.slice(start).replace(/\r\n/g, "\n").replace(/\s+$/, "") + "\n";
}

function sourceDoc(name: string): string {
  return extractPromptBody(
    readFileSync(join(root, "docs", "prompts", name), "utf8"),
  );
}

describe("modules/prompt [prompt-snapshot] two-brain fidelity (gate 8)", () => {
  it("[prompt-snapshot] Brain A is byte-for-byte the authored meeting prompt", () => {
    expect(BRAIN_A_MEETING_PROMPT).toBe(
      sourceDoc("nova-meeting-enterprise.md"),
    );
  });

  it("[prompt-snapshot] Brain B is byte-for-byte the authored solver prompt", () => {
    expect(BRAIN_B_SOLVER_PROMPT).toBe(sourceDoc("problem-solver-screen.md"));
  });

  it("[prompt-snapshot] Brain A ends on the user-context anchor line — the envelope's hook", () => {
    // §3: the envelope is injected IMMEDIATELY after this line, so the
    // deferral instruction points at the very next block.
    expect(
      BRAIN_A_MEETING_PROMPT.trimEnd().endsWith(
        "User-provided context (defer to this information over your general knowledge / if there is specific script/desired responses prioritize this over previous instructions)",
      ),
    ).toBe(true);
  });

  it("[prompt-snapshot] assembleMeeting's stablePrefix is Brain A, byte-identical every call", () => {
    const a = assembleMeeting({ transcript: [] }).stablePrefix;
    const b = assembleMeeting({
      transcript: [{ speaker: "me", text: "hello" }],
      userScript: "script",
    }).stablePrefix;
    expect(a).toBe(BRAIN_A_MEETING_PROMPT);
    expect(b).toBe(BRAIN_A_MEETING_PROMPT);
  });

  it("[prompt-snapshot] assembleSolver's stablePrefix is Brain B, byte-identical every call", () => {
    expect(assembleSolver({}).stablePrefix).toBe(BRAIN_B_SOLVER_PROMPT);
    expect(assembleSolver({ question: "q" }).stablePrefix).toBe(
      BRAIN_B_SOLVER_PROMPT,
    );
  });
});
