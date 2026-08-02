// LEGACY — superseded by `apps/server/src/modules/prompt/library/` (2026-08-01).
// Nothing on the live path runs this any more: `assemble()` composes its prefix
// from the library's SYSTEM_PROMPT plus the picked mode's block, so regenerating
// the flattened prompt changes no behaviour. Kept, with its output, as the
// reference for what the single monolithic prompt used to say.
//
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
 * LEGACY — UNWIRED as of 2026-08-01. Superseded by \`modules/prompt/library/\`,
 * which \`assemble()\` now builds every live prefix from (SYSTEM_PROMPT plus the
 * mode the user picked). Nothing imports this module on the live path; it stays
 * on disk as the reference for what the single monolithic prompt used to say,
 * and \`assemble.snapshot.test.ts\` still holds it byte-for-byte to its source doc
 * so it cannot rot into something that was never authored.
 *
 * GENERATED — DO NOT EDIT BY HAND. Gustavo's authored Nova live-copilot system
 * prompt, extracted VERBATIM (byte-for-byte) from
 * \`docs/prompts/nova-prompts-source.md\` (everything after its SOURCE-OF-RECORD
 * banner). Regenerate with \`scripts/gen-live-prompt.mjs\` if the source doc
 * changes.
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
