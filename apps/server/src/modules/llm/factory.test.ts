import { beforeEach, describe, expect, it, vi } from "vitest";

import { createProvidersFromEnv } from "./factory.js";
import type { ProviderId } from "./ports.js";

// Pass-through spies on every adapter creator, so the option-threading tests
// can see what each adapter was HANDED (the output ceiling is not observable
// through the LlmProvider port without issuing a real request).
const handed = vi.hoisted(() => ({
  maxOutputTokens: [] as (number | undefined)[],
}));
function passThrough<M extends Record<string, unknown>>(
  actual: M,
  key: keyof M,
): M {
  const real = actual[key] as (opts: { maxOutputTokens?: number }) => unknown;
  return {
    ...actual,
    [key]: (opts: { maxOutputTokens?: number }) => {
      handed.maxOutputTokens.push(opts.maxOutputTokens);
      return real(opts);
    },
  };
}
vi.mock("./adapters/anthropic.js", async (importActual) => {
  const actual = await importActual<typeof import("./adapters/anthropic.js")>();
  return passThrough(actual, "createAnthropicProvider");
});
vi.mock("./adapters/openai.js", async (importActual) => {
  const actual = await importActual<typeof import("./adapters/openai.js")>();
  return passThrough(actual, "createOpenAiProvider");
});
vi.mock("./adapters/google.js", async (importActual) => {
  const actual = await importActual<typeof import("./adapters/google.js")>();
  return passThrough(actual, "createGoogleProvider");
});
vi.mock("./adapters/groq.js", async (importActual) => {
  const actual = await importActual<typeof import("./adapters/groq.js")>();
  return passThrough(actual, "createGroqProvider");
});

beforeEach(() => {
  handed.maxOutputTokens.length = 0;
});

const ids = (env: Parameters<typeof createProvidersFromEnv>[0]): ProviderId[] =>
  createProvidersFromEnv(env).map((provider) => provider.id);

describe("createProvidersFromEnv", () => {
  it("returns an empty list when no keys are present (server boots keyless)", () => {
    expect(createProvidersFromEnv({})).toEqual([]);
  });

  it("builds only the providers whose key is present", () => {
    expect(ids({ OPENAI_API_KEY: "k" })).toEqual(["openai"]);
    expect(ids({ ANTHROPIC_API_KEY: "k", GROQ_API_KEY: "k" })).toEqual([
      "anthropic",
      "groq",
    ]);
  });

  it("emits providers in the config default failover order", () => {
    expect(
      ids({
        GROQ_API_KEY: "k",
        GOOGLE_API_KEY: "k",
        OPENAI_API_KEY: "k",
        ANTHROPIC_API_KEY: "k",
      }),
    ).toEqual(["anthropic", "openai", "google", "groq"]);
  });

  it("treats an empty-string key as absent", () => {
    expect(createProvidersFromEnv({ ANTHROPIC_API_KEY: "" })).toEqual([]);
  });

  it("threads the output ceiling into EVERY adapter it builds (the live 4096)", () => {
    createProvidersFromEnv(
      {
        ANTHROPIC_API_KEY: "k",
        OPENAI_API_KEY: "k",
        GOOGLE_API_KEY: "k",
        GROQ_API_KEY: "k",
      },
      { maxOutputTokens: 4096 },
    );
    expect(handed.maxOutputTokens).toEqual([4096, 4096, 4096, 4096]);
  });

  it("omits the ceiling when not asked — adapters keep their own default", () => {
    createProvidersFromEnv({ GOOGLE_API_KEY: "k" });
    expect(handed.maxOutputTokens).toEqual([undefined]);
  });
});
