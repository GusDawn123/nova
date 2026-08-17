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

  it("sends the configured output ceiling on the wire request", async () => {
    // The behavior the factory threading exists for: the ceiling must land in
    // the vendor request body, not merely in a constructor argument. The fetch
    // stub answers 500 — the REQUEST is captured either way, and the stream's
    // failure is expected and irrelevant to the assertion.
    const captured: { body?: unknown } = {};
    const realFetch = globalThis.fetch;
    globalThis.fetch = (_url, init) => {
      captured.body =
        typeof init?.body === "string" ? JSON.parse(init.body) : null;
      return Promise.resolve(new Response("", { status: 500 }));
    };
    try {
      const provider = createGoogleProvider({
        apiKey: "test-key",
        maxOutputTokens: 4096,
      });
      const drain = async (): Promise<void> => {
        for await (const event of provider.stream(
          { messages: [{ role: "user", content: "hi" }] },
          new AbortController().signal,
        )) {
          void event;
        }
      };
      await expect(drain()).rejects.toThrow();
      expect(captured.body).toMatchObject({
        generationConfig: { maxOutputTokens: 4096 },
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("sends NO output ceiling when none is configured (answers uncapped)", async () => {
    // The production posture (Gustavo, 2026-08-17): no product cap — the wire
    // request must not carry maxOutputTokens at all.
    const captured: { body?: unknown } = {};
    const realFetch = globalThis.fetch;
    globalThis.fetch = (_url, init) => {
      captured.body =
        typeof init?.body === "string" ? JSON.parse(init.body) : null;
      return Promise.resolve(new Response("", { status: 500 }));
    };
    try {
      const provider = createGoogleProvider({ apiKey: "test-key" });
      const drain = async (): Promise<void> => {
        for await (const event of provider.stream(
          { messages: [{ role: "user", content: "hi" }] },
          new AbortController().signal,
        )) {
          void event;
        }
      };
      await expect(drain()).rejects.toThrow();
      const body = captured.body as {
        generationConfig?: Record<string, unknown>;
      };
      expect(body.generationConfig ?? {}).not.toHaveProperty("maxOutputTokens");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
