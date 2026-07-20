import { describe, expect, it } from "vitest";

import { createGroqProvider } from "./groq.js";

describe("adapters/groq", () => {
  it("builds a provider with the groq id (reusing the OpenAI-compatible engine)", () => {
    expect(createGroqProvider({ apiKey: "test-key" }).id).toBe("groq");
  });
});
