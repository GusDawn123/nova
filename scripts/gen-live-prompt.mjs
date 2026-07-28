// Regenerate the verbatim live-copilot system prompt module from the source doc.
// Usage: node scripts/gen-live-prompt.mjs
// The prompt text is Gustavo's authored work (docs/prompts/nova-prompts-source.md);
// this script extracts it byte-for-byte — it never rewrites prose (RULES §9).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcPath = join(root, "docs/prompts/nova-prompts-source.md");
const outPath = join(
  root,
  "apps/server/src/modules/prompt/content/system-prompt.ts",
);

const src = readFileSync(srcPath, "utf8");
const endComment = src.indexOf("-->");
if (endComment === -1) throw new Error("source banner comment not found");
const body =
  src
    .slice(endComment + 3)
    .replace(/^\n+/, "")
    .replace(/\s+$/, "") + "\n";

const header = `/**
 * GENERATED — DO NOT EDIT BY HAND. Gustavo's authored Nova live-copilot system
 * prompt, extracted VERBATIM (byte-for-byte) from
 * \`docs/prompts/nova-prompts-source.md\` (everything after its SOURCE-OF-RECORD
 * banner). Regenerate with \`scripts/gen-live-prompt.mjs\` if the source doc
 * changes; the byte-stable snapshot test (\`assemble.snapshot.test.ts\`) fails the
 * build if this string drifts, so the vendor prompt cache can never silently
 * churn (design: live-pipeline.md §modules/prompt; adr-0004 §6).
 *
 * Code assembles, code NEVER writes/paraphrases this prose (RULES §9 / Phase 7
 * verbatim-prompt constraint). This is the full monolithic stablePrefix:
 * identity, security, decision hierarchy, transcript rules, format rules,
 * question-type handling, and the general mode body.
 */
export const LIVE_SYSTEM_PROMPT_GENERAL = ${JSON.stringify(body)};
`;
writeFileSync(outPath, header);
console.log(
  `wrote ${outPath} (${Buffer.byteLength(body, "utf8")} prompt bytes)`,
);
