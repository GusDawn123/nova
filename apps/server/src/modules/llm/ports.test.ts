import { describe, expect, it } from "vitest";

import {
  chatRequestSchema,
  llmStreamEventSchema,
  noopMeter,
  providerIdSchema,
} from "./ports.js";

describe("chatRequestSchema", () => {
  it("accepts a minimal valid request", () => {
    const parsed = chatRequestSchema.parse({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.model).toBeUndefined();
    expect(parsed.providerOrder).toBeUndefined();
  });

  it("requires at least one message", () => {
    expect(chatRequestSchema.safeParse({ messages: [] }).success).toBe(false);
  });

  it("rejects unknown roles", () => {
    expect(
      chatRequestSchema.safeParse({
        messages: [{ role: "tool", content: "x" }],
      }).success,
    ).toBe(false);
  });

  it("rejects unknown provider ids in the override order", () => {
    expect(
      chatRequestSchema.safeParse({
        messages: [{ role: "user", content: "x" }],
        providerOrder: ["mistral"],
      }).success,
    ).toBe(false);
  });

  it("accepts optional model and providerOrder overrides", () => {
    const parsed = chatRequestSchema.parse({
      messages: [{ role: "system", content: "x" }],
      model: "gpt-x",
      providerOrder: ["openai", "groq"],
    });
    expect(parsed.model).toBe("gpt-x");
    expect(parsed.providerOrder).toEqual(["openai", "groq"]);
  });
});

describe("llmStreamEventSchema", () => {
  it("parses token and done events", () => {
    expect(llmStreamEventSchema.parse({ type: "token", text: "a" })).toEqual({
      type: "token",
      text: "a",
    });
    expect(llmStreamEventSchema.parse({ type: "done", usage: null })).toEqual({
      type: "done",
      usage: null,
    });
    expect(
      llmStreamEventSchema.parse({
        type: "done",
        usage: { inputTokens: 3, outputTokens: 4 },
      }),
    ).toEqual({ type: "done", usage: { inputTokens: 3, outputTokens: 4 } });
  });

  it("rejects unknown event types", () => {
    expect(
      llmStreamEventSchema.safeParse({ type: "chunk", text: "a" }).success,
    ).toBe(false);
  });

  it("requires usage (nullable) on a done event", () => {
    expect(llmStreamEventSchema.safeParse({ type: "done" }).success).toBe(
      false,
    );
  });
});

describe("providerIdSchema", () => {
  it("accepts the four known providers", () => {
    for (const id of ["anthropic", "openai", "google", "groq"]) {
      expect(providerIdSchema.parse(id)).toBe(id);
    }
  });

  it("rejects an unknown provider", () => {
    expect(providerIdSchema.safeParse("mistral").success).toBe(false);
  });
});

describe("noopMeter", () => {
  it("records usage without throwing", () => {
    expect(() => {
      noopMeter.recordUsage({ provider: "anthropic", inputTokens: 1 });
    }).not.toThrow();
  });
});
