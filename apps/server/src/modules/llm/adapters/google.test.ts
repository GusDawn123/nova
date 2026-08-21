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

  it("skips the thinking knob for the lite default — and pins LOW for non-lite", async () => {
    // The default is lite again (2026-08-19 revert) and lite-lineage models
    // 400 on any thinkingConfig, so the knob must be ABSENT by default. An
    // explicit non-lite override (e.g. 3.7-flash, which defaults to MEDIUM and
    // bills thinking tokens as output) must still get thinkingLevel LOW
    // pinned (Gustavo, 2026-08-17).
    const bodies: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (_url, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      return Promise.resolve(new Response("", { status: 500 }));
    };
    try {
      const drain = async (model?: string): Promise<void> => {
        const provider = createGoogleProvider({
          apiKey: "test-key",
          ...(model !== undefined ? { model } : {}),
        });
        for await (const event of provider.stream(
          { messages: [{ role: "user", content: "hi" }] },
          new AbortController().signal,
        )) {
          void event;
        }
      };
      await expect(drain()).rejects.toThrow();
      expect(bodies[0]).not.toContain("thinkingLevel");

      await expect(drain("gemini-3.7-flash")).rejects.toThrow();
      // The SDK enum serializes as "LOW" on the wire.
      expect(bodies[1]).toContain('"thinkingLevel":"LOW"');

      // gemini-3.5-flash (the live lane since 2026-08-21) runs KNOB-FREE on
      // purpose — Natively parity, the register's tuned configuration.
      await expect(drain("gemini-3.5-flash")).rejects.toThrow();
      expect(bodies[2]).not.toContain("thinkingLevel");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("sends the configured topP on the wire (the reference's 0.85)", async () => {
    const bodies: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (_url, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      return Promise.resolve(new Response("", { status: 500 }));
    };
    try {
      const provider = createGoogleProvider({
        apiKey: "test-key",
        topP: 0.85,
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
      expect(bodies[0]).toContain('"topP":0.85');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("sends the configured temperature on the wire — and omits it by default", async () => {
    // The live wiring passes 0.3 (Natively reference: 0.25–0.4 on answer
    // paths); everything else must keep the vendor's own default, so the
    // param must not exist on the wire unless configured.
    const bodies: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (_url, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      return Promise.resolve(new Response("", { status: 500 }));
    };
    try {
      const drain = async (temperature?: number): Promise<void> => {
        const provider = createGoogleProvider({
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

      await expect(drain()).rejects.toThrow();
      expect(bodies[1]).not.toContain("temperature");
      // topP rides the wire only when configured (the live lane's 0.85).
      expect(bodies[1]).not.toContain("topP");
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
