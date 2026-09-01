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

  it("sends temperature + reasoning 'none' on the wire — temperature omitted by default", async () => {
    // Same wire-capture pattern as adapters/google: the stub answers 500, the
    // REQUEST is captured either way, and the stream's failure is expected.
    // Pins the two live-path knobs where they matter — the vendor request —
    // not merely in constructor arguments.
    const bodies: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (_url, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      return Promise.resolve(new Response("", { status: 500 }));
    };
    try {
      const drain = async (temperature?: number): Promise<void> => {
        const provider = createOpenAiProvider({
          apiKey: "test-key",
          ...(temperature !== undefined ? { temperature } : {}),
        });
        for await (const event of provider.stream(
          { messages: [{ role: "user", content: "hi" }] },
          new AbortController().signal,
        )) {
          void event;
        }
      };
      await expect(drain(0.3)).rejects.toThrow();
      expect(bodies[0]).toContain('"temperature":0.3');
      // Reasoning OFF (the 2026-08-19 revert setting) rides every request.
      expect(bodies[0]).toContain('"reasoning_effort":"none"');

      await expect(drain()).rejects.toThrow();
      expect(bodies[1]).not.toContain("temperature");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
