import { describe, expect, it } from "vitest";

import { createProvidersFromEnv } from "./factory.js";
import type { ProviderId } from "./ports.js";

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
});
