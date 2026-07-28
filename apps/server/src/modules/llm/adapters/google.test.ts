import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../ports.js";
import { createGoogleProvider, toGoogleContents } from "./google.js";

describe("adapters/google — translation", () => {
  it("hoists system turns into systemInstruction and maps assistant→model", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be terse" },
      { role: "system", content: "answer in English" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(toGoogleContents(messages)).toEqual({
      systemInstruction: "be terse\n\nanswer in English",
      contents: [
        { role: "user", parts: [{ text: "hi" }] },
        { role: "model", parts: [{ text: "hello" }] },
      ],
    });
  });

  it("omits systemInstruction when there are no system turns", () => {
    const result = toGoogleContents([{ role: "user", content: "hi" }]);
    expect(result.systemInstruction).toBeUndefined();
    expect(result.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
    ]);
  });

  it("builds a provider with the google id", () => {
    expect(createGoogleProvider({ apiKey: "test-key" }).id).toBe("google");
  });
});
