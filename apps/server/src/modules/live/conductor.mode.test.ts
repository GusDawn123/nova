import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { liveLlmConfig } from "../llm/index.js";
import { makeMockProvider } from "../llm/testing/mock-provider.js";
import { DONE, makeRouter, tok } from "../llm/testing/router-harness.js";

import { conductorConfigSchema } from "./conductor-config.js";
import { createLiveConductor } from "./conductor.js";

/**
 * [conductor-mode] The last hop: the conductor's session mode reaches
 * `assemble()`, so what the vendor actually receives is the prompt the user
 * picked. Asserted on the system message the mock provider RECORDS — the only
 * place that proves the whole chain rather than an argument being passed along.
 */

const CONFIG = conductorConfigSchema.parse({
  coalesceMs: 50,
  firstTokenDeadlineMs: 4000,
});

/** Distinctive strings from each mode's block (same markers as the prompt suite). */
const TECHNICAL_MARKER = "If the question calls for CODE";
const FINANCE_MARKER = "Structure the thinking with an established framework";

/** Fire one question through a conductor and return the system prompt it sent. */
async function systemPromptFor(
  mode: Parameters<typeof createLiveConductor>[0]["mode"],
): Promise<string> {
  const provider = makeMockProvider("google", {
    firstTokenDelayMs: 10,
    events: [tok("Answer"), DONE],
  });
  const conductor = createLiveConductor({
    send: () => undefined,
    router: makeRouter([provider], liveLlmConfig()),
    config: CONFIG,
    autoSuggest: true,
    ...(mode !== undefined ? { mode } : {}),
  });
  conductor.onFinal("So how would you price this for us?", "them");
  await vi.advanceTimersByTimeAsync(200);

  const call = provider.calls[0];
  expect(call, "the conductor never called the provider").toBeDefined();
  const system = call?.request.messages.find((m) => m.role === "system");
  expect(system, "no system message was sent").toBeDefined();
  return system?.content ?? "";
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("modules/live [conductor-mode] the session mode reaches the vendor", () => {
  it("[conductor-mode] a technical session sends the technical block", async () => {
    const system = await systemPromptFor("technical");
    expect(system).toContain(TECHNICAL_MARKER);
    expect(system).not.toContain(FINANCE_MARKER);
  });

  it("[conductor-mode] a finance session sends the finance block", async () => {
    const system = await systemPromptFor("finance");
    expect(system).toContain(FINANCE_MARKER);
    expect(system).not.toContain(TECHNICAL_MARKER);
  });

  it("[conductor-mode] an unset mode falls back to general — no domain block", async () => {
    // Matches the wire rule (an omitted `mode` means general) so a conductor
    // built by an older path cannot end up prompt-less.
    const system = await systemPromptFor(undefined);
    expect(system).not.toContain(TECHNICAL_MARKER);
    expect(system).not.toContain(FINANCE_MARKER);
    expect(system).toContain("You are Nova");
  });
});
