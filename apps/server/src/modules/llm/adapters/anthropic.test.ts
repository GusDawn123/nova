import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../ports.js";
import { createAnthropicProvider, toAnthropicMessages } from "./anthropic.js";

describe("adapters/anthropic — translation", () => {
  it("hoists system turns into a joined `system` string and maps the rest", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be terse" },
      { role: "system", content: "answer in English" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "bye" },
    ];
    expect(toAnthropicMessages(messages)).toEqual({
      system: "be terse\n\nanswer in English",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "bye" },
      ],
    });
  });

  it("omits `system` entirely when there are no system turns", () => {
    const result = toAnthropicMessages([{ role: "user", content: "hi" }]);
    expect(result.system).toBeUndefined();
    expect(result.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("builds a provider with the anthropic id", () => {
    expect(createAnthropicProvider({ apiKey: "test-key" }).id).toBe(
      "anthropic",
    );
  });
});
