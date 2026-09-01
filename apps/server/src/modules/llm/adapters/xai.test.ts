import { describe, expect, it } from "vitest";

import { createProvidersFromEnv } from "../factory.js";
import { createXaiProvider } from "./xai.js";

describe("adapters/xai — construction", () => {
  it("builds a provider with the xai id", () => {
    expect(createXaiProvider({ apiKey: "test-key" }).id).toBe("xai");
  });

  it("joins the env factory lineup only when XAI_API_KEY is present", () => {
    const withKey = createProvidersFromEnv({
      OPENAI_API_KEY: "k1",
      XAI_API_KEY: "k2",
    });
    expect(withKey.map((p) => p.id)).toEqual(["openai", "xai"]);

    const withoutKey = createProvidersFromEnv({ OPENAI_API_KEY: "k1" });
    expect(withoutKey.map((p) => p.id)).toEqual(["openai"]);
  });
});
