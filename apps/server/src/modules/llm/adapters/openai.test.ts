import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../ports.js";
import { toOpenAiMessages } from "./openai-compatible.js";
import { createOpenAiProvider } from "./openai.js";

describe("adapters/openai — translation", () => {
  it("maps every role one-to-one (system/user/assistant are all valid)", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(toOpenAiMessages(messages)).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("builds a provider with the openai id", () => {
    expect(createOpenAiProvider({ apiKey: "test-key" }).id).toBe("openai");
  });
});
