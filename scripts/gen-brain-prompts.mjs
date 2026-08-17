// Regenerate the two-brain prompt modules from their authored source docs.
// Usage: node scripts/gen-brain-prompts.mjs
//
// The prompt texts are Gustavo's authored work; this script extracts them
// byte-for-byte — it never rewrites prose (RULES §9). Extraction rule: the
// prompt body starts at the first `<core_identity>` tag, which mechanically
// skips the SOURCE-OF-RECORD banner (an HTML comment) and any doc-furniture
// title line without touching a byte of authored text. Trailing whitespace is
// normalized to one final newline.
//
// `assemble.two-brain.snapshot.test.ts` re-applies this exact rule to the
// source docs and holds the generated constants byte-for-byte to them.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const BRAINS = [
  {
    src: "docs/prompts/nova-meeting-enterprise.md",
    out: "apps/server/src/modules/prompt/content/meeting-enterprise.ts",
    constant: "BRAIN_A_MEETING_PROMPT",
    identity: "Brain A — the live-meeting co-pilot",
    note: [
      "The default system prompt whenever a meeting is running. Its text ends",
      "on the user-provided-context anchor line; `assembleMeeting` injects the",
      "context envelope IMMEDIATELY after it (design doc §3).",
    ],
  },
  {
    src: "docs/prompts/problem-solver-screen.md",
    out: "apps/server/src/modules/prompt/content/problem-solver.ts",
    constant: "BRAIN_B_SOLVER_PROMPT",
    identity: "Brain B — the problem solver",
    note: [
      "Only user-initiated asks may route here (it always acts — never wire it",
      "to an automatic trigger). Routed by chunk M5; M2 lands the entry point.",
    ],
  },
];

export function extractPromptBody(source) {
  const start = source.indexOf("<core_identity>");
  if (start === -1) throw new Error("no <core_identity> tag in source doc");
  // CRLF→LF is transport normalization (git checkout artifact on Windows),
  // not a prose edit — it keeps the constant byte-identical on every platform.
  return (
    source
      .slice(start)
      .replace(/\r\n/g, "\n")
      .replace(/\s+$/, "") + "\n"
  );
}

for (const brain of BRAINS) {
  const src = readFileSync(join(root, brain.src), "utf8");
  const body = extractPromptBody(src);
  const header = `/**
 * GENERATED — DO NOT EDIT BY HAND. ${brain.identity}: Gustavo's authored
 * system prompt, extracted VERBATIM (byte-for-byte, from the first
 * \`<core_identity>\` tag) out of \`${brain.src}\`. Regenerate with
 * \`scripts/gen-brain-prompts.mjs\` if the source doc changes.
 *
 * ${brain.note.join("\n * ")}
 *
 * Code assembles, code NEVER writes/paraphrases this prose (RULES §9). Never
 * active in the same request as the other brain (the never-both law, enforced
 * structurally in \`two-brain.ts\` and pinned by its tests).
 */
export const ${brain.constant} = ${JSON.stringify(body)};
`;
  writeFileSync(join(root, brain.out), header);
  console.log(
    `wrote ${brain.out} (${Buffer.byteLength(body, "utf8")} prompt bytes)`,
  );
}
