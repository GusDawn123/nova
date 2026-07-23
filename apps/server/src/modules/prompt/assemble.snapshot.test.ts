import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { assemble } from "./assemble.js";
import { LIVE_SYSTEM_PROMPT_GENERAL } from "./content/system-prompt.js";

/**
 * [prompt-snapshot] The stablePrefix is BYTE-STABLE (design: live-pipeline.md,
 * adr-0004 §6): the vendor prompt cache keys on an exact prefix match, so any
 * drift silently halves throughput and must fail the build. This pins the sha256
 * of the assembled prefix AND proves it is byte-for-byte the authored source
 * (never paraphrased — RULES §9).
 */
describe("modules/prompt [prompt-snapshot] byte-stable stablePrefix", () => {
  it("[prompt-snapshot] the stablePrefix hash is pinned", () => {
    const { stablePrefix } = assemble("general", { transcript: [] });
    const hash = createHash("sha256").update(stablePrefix, "utf8").digest("hex");
    // Regenerating the prompt from the source doc (scripts/gen-live-prompt.mjs)
    // is the ONLY sanctioned way to change this hash — never a hand edit.
    expect(hash).toBe(
      "77bb8f980c5ac57921c94e8d13222f58a1ececf9de3f60cd719004b852d7b400",
    );
  });

  it("[prompt-snapshot] the stablePrefix does not vary with the dynamic context", () => {
    const a = assemble("general", { transcript: [] }).stablePrefix;
    const b = assemble("general", {
      transcript: [{ speaker: "them", text: "what is Databricks?" }],
      ragSnippets: [{ header: "Doc", content: "some memory" }],
      userContext: "the user sells widgets",
    }).stablePrefix;
    expect(a).toBe(b);
  });

  it("[prompt-snapshot] the prefix is byte-for-byte the authored source doc", () => {
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
