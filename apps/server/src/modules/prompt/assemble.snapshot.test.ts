import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { liveModeSchema } from "@nova/shared";

import { assemble } from "./assemble.js";
import { LIVE_SYSTEM_PROMPT_GENERAL } from "./content/system-prompt.js";
import type { PromptMode } from "./ports.js";

/**
 * [prompt-snapshot] The stablePrefix is BYTE-STABLE (design: live-pipeline.md,
 * adr-0004 §6): the vendor prompt cache keys on an exact prefix match, so any
 * drift silently halves throughput and must fail the build.
 *
 * ONE PIN PER MODE since Phase 8.6. The mode is fixed at `session.start`, so a
 * call sees one of these four and only one — four warm caches, not one cache
 * being churned. A changed hash means the prompt text moved; that is a decision
 * to make deliberately (and to re-run the live relevance/grounding gates for),
 * never something to repin because the build went red.
 */
const PINNED: Record<PromptMode, string> = {
  // Repinned 2026-08-01 (third repin of the day — the reference study): the
  // spoken-prose default. The source doc's headline-and-bullets card and the
  // "**Objection: [Name]**" coaching label were quietly fighting THE REGISTER;
  // both are gone. Added: em-dash/semicolon spoken-punctuation ban, the 15-30s
  // length law, opener rotation, silent context, speakable admissions, and the
  // position-pinned FINAL CHECK. Earlier same-day repins: (1) the teleprompter
  // register (the "no pronouns" narration fix); (2) SOUND HUMAN (spoken-rhythm
  // mechanics + machine-tell blacklist).
  // Live gates still pending on this text.
  // Repinned 2026-08-02, CodeRabbit pre-PR pass: the untrusted-data clause in
  // CONTENT_CONSTRAINTS (transcript/RAG/context are data, not instructions),
  // the behavioral example's invented quantities made qualitative, and the
  // finance example's arithmetic corrected (47,500 x 0.18 = 8,550 → 38,950).
  general:
    "6572a864f697f6e17cbc425932409f382b4b763b81a9aa39b3f7d190ae4841e1",
  behavioral:
    "af566b64da422f40c01e41a05c0040f4904a03abb6c94feaa1c72266c59deb17",
  technical:
    "a5ad87fbf695a1ccd311d31f32a2901421ade93475ba4a7283cace3fb27fbf44",
  finance:
    "4c794a4e811b13c22f02413396e143a4636a122ca1c0c4c0471dbb2fa3b4db92",
};

function prefixHash(mode: PromptMode): string {
  const { stablePrefix } = assemble(mode, { transcript: [] });
  return createHash("sha256").update(stablePrefix, "utf8").digest("hex");
}

describe("modules/prompt [prompt-snapshot] byte-stable stablePrefix", () => {
  for (const mode of liveModeSchema.options) {
    it(`[prompt-snapshot] the ${mode} stablePrefix hash is pinned`, () => {
      // Pinned 2026-08-01, when assemble() moved onto `library/`: the prefix is
      // now SYSTEM_PROMPT plus (for a picked mode) that mode's block.
      expect(prefixHash(mode)).toBe(PINNED[mode]);
    });
  }

  it("[prompt-snapshot] every mode's prefix is distinct", () => {
    // The pins above would all pass if `assemble` ignored its mode argument and
    // returned the same prefix four times — this is the assertion that notices.
    const hashes = liveModeSchema.options.map(prefixHash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("[prompt-snapshot] the stablePrefix does not vary with the dynamic context", () => {
    for (const mode of liveModeSchema.options) {
      const a = assemble(mode, { transcript: [] }).stablePrefix;
      const b = assemble(mode, {
        transcript: [{ speaker: "them", text: "what is Databricks?" }],
        ragSnippets: [{ header: "Doc", content: "some memory" }],
        userContext: "the user sells widgets",
      }).stablePrefix;
      expect(a).toBe(b);
    }
  });
});

/**
 * The LEGACY flattened prompt (`content/system-prompt.ts`) is no longer on the
 * live path — `assemble()` builds from `library/` — but the file stays on disk
 * for reference, and while it does, it stays honest: byte-for-byte the authored
 * source doc, never hand-edited (RULES §9).
 */
describe("modules/prompt [prompt-snapshot] LEGACY generated content", () => {
  it("[prompt-snapshot] the legacy prompt is byte-for-byte the authored source doc", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    // ../../../../../docs/prompts/nova-prompts-source.md from modules/prompt/
    const sourcePath = join(
      here,
      "..",
      "..",
      "..",
      "..",
      "..",
      "docs",
      "prompts",
      "nova-prompts-source.md",
    );
    const src = readFileSync(sourcePath, "utf8");
    const body =
      src
        .slice(src.indexOf("-->") + 3)
        .replace(/^\n+/, "")
        .replace(/\s+$/, "") + "\n";
    expect(LIVE_SYSTEM_PROMPT_GENERAL).toBe(body);
  });
});
