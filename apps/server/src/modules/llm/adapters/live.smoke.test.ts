import { describe, expect, it, vi } from "vitest";

import { llmConfigSchema } from "../config.js";
import type {
  ChatRequest,
  LlmProvider,
  LlmStreamEvent,
  Meter,
  ProviderId,
  UsageEntry,
} from "../ports.js";
import { createLlmRouter } from "../router.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createGoogleProvider } from "./google.js";
import { createGroqProvider } from "./groq.js";
import { createOpenAiProvider } from "./openai.js";

/**
 * Live smoke, one `describe.skipIf` per provider — runs ONLY when that vendor's
 * API key is in the env (CI has none, so the whole file skips cleanly). Each
 * case drives the REAL adapter THROUGH the router (single-provider order) with a
 * recording meter stub, and asserts the playbook's shape: ≥1 token, one done,
 * and that the metering interface saw the provider id. Cost is kept trivial via
 * a tiny prompt and max output.
 */

// Per-file timeout override for real network latency (not a global config change).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REQ: ChatRequest = {
  messages: [{ role: "user", content: "Reply with exactly: ok" }],
};
const TINY_MAX_OUTPUT = 16;

async function runThroughRouter(
  provider: LlmProvider,
): Promise<{ events: LlmStreamEvent[]; usage: UsageEntry[] }> {
  const usage: UsageEntry[] = [];
  const meter: Meter = {
    recordUsage: (entry) => usage.push(entry),
  };
  const config = llmConfigSchema.parse({
    defaultOrder: [provider.id],
    ttftTimeoutMs: 15_000,
    stallTimeoutMs: 25_000,
  });
  const router = createLlmRouter({ providers: [provider], config, meter });

  const events: LlmStreamEvent[] = [];
  for await (const event of router.stream(REQ)) {
    events.push(event);
  }
  return { events, usage };
}

function expectSmokeShape(
  id: ProviderId,
  events: LlmStreamEvent[],
  usage: UsageEntry[],
): void {
  const tokens = events.filter((event) => event.type === "token");
  const dones = events.filter((event) => event.type === "done");
  expect(tokens.length).toBeGreaterThanOrEqual(1);
  expect(dones.length).toBe(1);

  const entry = usage.find((u) => u.provider === id);
  expect(entry).toBeDefined();
  // Usage numbers only when the vendor reports them (all four do today, but
  // don't hard-fail the smoke if a count is absent).
  if (entry?.inputTokens !== undefined) {
    expect(entry.inputTokens).toBeGreaterThan(0);
  }
  if (entry?.outputTokens !== undefined) {
    expect(entry.outputTokens).toBeGreaterThan(0);
  }
}

const anthropicKey = process.env.ANTHROPIC_API_KEY;
describe.skipIf(!anthropicKey)("live smoke [anthropic]", () => {
  it("streams tokens + done through the router and meters the provider", async () => {
    if (!anthropicKey) return; // narrow for the type checker; skipIf guards runtime
    const provider = createAnthropicProvider({
      apiKey: anthropicKey,
      maxOutputTokens: TINY_MAX_OUTPUT,
    });
    const { events, usage } = await runThroughRouter(provider);
    expectSmokeShape("anthropic", events, usage);
  });
});

const openaiKey = process.env.OPENAI_API_KEY;
describe.skipIf(!openaiKey)("live smoke [openai]", () => {
  it("streams tokens + done through the router and meters the provider", async () => {
    if (!openaiKey) return;
    const provider = createOpenAiProvider({
      apiKey: openaiKey,
      maxOutputTokens: TINY_MAX_OUTPUT,
    });
    const { events, usage } = await runThroughRouter(provider);
    expectSmokeShape("openai", events, usage);
  });
});

const googleKey = process.env.GOOGLE_API_KEY;
describe.skipIf(!googleKey)("live smoke [google]", () => {
  it("streams tokens + done through the router and meters the provider", async () => {
    if (!googleKey) return;
    const provider = createGoogleProvider({
      apiKey: googleKey,
      maxOutputTokens: TINY_MAX_OUTPUT,
    });
    const { events, usage } = await runThroughRouter(provider);
    expectSmokeShape("google", events, usage);
  });
});

const groqKey = process.env.GROQ_API_KEY;
describe.skipIf(!groqKey)("live smoke [groq]", () => {
  it("streams tokens + done through the router and meters the provider", async () => {
    if (!groqKey) return;
    const provider = createGroqProvider({
      apiKey: groqKey,
      maxOutputTokens: TINY_MAX_OUTPUT,
    });
    const { events, usage } = await runThroughRouter(provider);
    expectSmokeShape("groq", events, usage);
  });
});
