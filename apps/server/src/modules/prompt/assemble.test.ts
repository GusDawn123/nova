import { describe, expect, it } from "vitest";

import { assemble } from "./assemble.js";
import { approxTokens, promptConfigSchema } from "./config.js";
import type { PromptTranscriptTurn } from "./ports.js";

/**
 * [prompt-assemble] The dynamic suffix: transcript LAST, RAG under a hard token
 * budget, user context hard-guarded (delimited DATA after the prefix), and
 * everything windowed to shrink — never delay — the first token.
 */
describe("modules/prompt [prompt-assemble] dynamic suffix", () => {
  it("[prompt-assemble] transcript is rendered me:/them: and ends the prompt", () => {
    const { dynamicSuffix } = assemble("general", {
      transcript: [
        { speaker: "me", text: "hello" },
        { speaker: "them", text: "what is Databricks?" },
      ],
    });
    expect(dynamicSuffix).toContain("me: hello");
    expect(dynamicSuffix).toContain("them: what is Databricks?");
    // Transcript block is last — the current moment is the end of the prompt.
    expect(dynamicSuffix.trimEnd().endsWith("them: what is Databricks?")).toBe(
      true,
    );
  });

  it("[prompt-assemble] maps null/unknown speakers and preserves named ones", () => {
    const { dynamicSuffix } = assemble("general", {
      transcript: [
        { speaker: null, text: "unlabeled" },
        { speaker: "Speaker 2", text: "named" },
        { speaker: "ME", text: "caps" },
      ],
    });
    expect(dynamicSuffix).toContain("them: unlabeled");
    expect(dynamicSuffix).toContain("Speaker 2: named");
    expect(dynamicSuffix).toContain("me: caps");
  });

  it("[prompt-assemble] windows the transcript to the token budget, keeping the newest", () => {
    const turns: PromptTranscriptTurn[] = Array.from({ length: 200 }, (_, i) => ({
      speaker: i % 2 === 0 ? "me" : "them",
      text: `turn number ${i} with some filler words to add length here`,
    }));
    const config = promptConfigSchema.parse({ transcriptBudgetTokens: 60 });
    const { dynamicSuffix } = assemble("general", { transcript: turns }, config);

    // The newest turn survives; an old one is dropped.
    expect(dynamicSuffix).toContain("turn number 199");
    expect(dynamicSuffix).not.toContain("turn number 0 ");
    // The kept transcript slice respects the budget (allow the single-turn
    // overflow rule + section labels a little headroom).
    const transcriptPart = dynamicSuffix.split("TRANSCRIPT\n")[1] ?? "";
    expect(approxTokens(transcriptPart)).toBeLessThanOrEqual(80);
  });

  it("[prompt-assemble] trims RAG snippets to the hard budget (ranked, best-first)", () => {
    const config = promptConfigSchema.parse({ ragBudgetTokens: 30 });
    const { dynamicSuffix } = assemble(
      "general",
      {
        transcript: [{ speaker: "them", text: "hi" }],
        ragSnippets: [
          { header: "A", content: "first snippet kept within budget" },
          { header: "B", content: "second snippet ".repeat(40) },
          { header: "C", content: "third snippet dropped after budget" },
        ],
      },
      config,
    );
    expect(dynamicSuffix).toContain("RELEVANT CONTEXT FROM MEMORY");
    expect(dynamicSuffix).toContain("first snippet kept");
    // The oversize B blows the budget → B and everything after are dropped.
    expect(dynamicSuffix).not.toContain("third snippet dropped");
  });

  it("[prompt-assemble] user context is delimited DATA after the prefix, truncated to budget", () => {
    const config = promptConfigSchema.parse({ userContextBudgetTokens: 10 });
    const big = "x".repeat(1000);
    const { stablePrefix, dynamicSuffix } = assemble(
      "general",
      { transcript: [{ speaker: "them", text: "hi" }], userContext: big },
      config,
    );
    expect(dynamicSuffix).toContain("USER CONTEXT");
    expect(dynamicSuffix).toContain("<<<");
    expect(dynamicSuffix).toContain(">>>");
    // Truncated to ~10 tokens * 4 chars — far shorter than the 1000-char input.
    expect(dynamicSuffix.length).toBeLessThan(stablePrefix.length);
    expect(dynamicSuffix).not.toContain("x".repeat(200));
  });

  it("[prompt-assemble] omits absent blocks entirely (no empty labels)", () => {
    const { dynamicSuffix } = assemble("general", {
      transcript: [{ speaker: "them", text: "hi" }],
    });
    expect(dynamicSuffix).not.toContain("USER CONTEXT");
    expect(dynamicSuffix).not.toContain("RELEVANT CONTEXT FROM MEMORY");
    expect(dynamicSuffix).toContain("TRANSCRIPT");
  });
});
