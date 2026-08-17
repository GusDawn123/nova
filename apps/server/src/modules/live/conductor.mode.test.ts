import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { liveLlmConfig } from "../llm/index.js";
import { makeMockProvider } from "../llm/testing/mock-provider.js";
import { DONE, makeRouter, tok } from "../llm/testing/router-harness.js";
import { BRAIN_A_MEETING_PROMPT } from "../prompt/content/meeting-enterprise.js";
import type { RagService } from "../rag/index.js";

import { conductorConfigSchema } from "./conductor-config.js";
import { createLiveConductor } from "./conductor.js";

/**
 * [conductor-mode] The last hop, under the M2 contract: EVERY meeting request
 * the conductor fires reaches the vendor on Brain A — the authored enterprise
 * prompt, byte-for-byte, ONE prefix regardless of the session's legacy mode
 * enum (which is accepted for wire compatibility but no longer shapes the
 * prompt; M3 retires it for `mode_id`). Asserted on the system message the
 * mock provider RECORDS — the only place that proves the whole chain.
 */

const CONFIG = conductorConfigSchema.parse({
  coalesceMs: 50,
  firstTokenDeadlineMs: 4000,
});

/** Distinctive strings from the legacy mode blocks — must never appear now. */
const TECHNICAL_MARKER = "If the question calls for CODE";
const FINANCE_MARKER = "Structure the thinking with an established framework";

/** Fire one question through a conductor; return the system + user messages sent. */
async function messagesFor(
  mode: Parameters<typeof createLiveConductor>[0]["mode"],
): Promise<{ system: string; user: string }> {
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
  const user = call?.request.messages.find((m) => m.role === "user");
  return { system: system?.content ?? "", user: user?.content ?? "" };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("modules/live [conductor-mode] every session sends Brain A (M2)", () => {
  it.each([
    ["technical", "technical"],
    ["finance", "finance"],
    ["general", "general"],
    ["unset", undefined],
  ] as const)(
    "[conductor-mode] a %s session sends the Brain A prefix, no legacy mode block",
    async (_label, mode) => {
      const { system } = await messagesFor(mode);
      expect(system).toBe(BRAIN_A_MEETING_PROMPT);
      expect(system).not.toContain(TECHNICAL_MARKER);
      expect(system).not.toContain(FINANCE_MARKER);
    },
  );

  it("[conductor-mode] the envelope opens the user message — the anchor's very next block (§3)", async () => {
    // The system message ends on the deferral anchor; the user message that
    // follows it must begin with the envelope, then end on the transcript.
    const { user } = await messagesFor("general");
    expect(user.startsWith("<user_provided_context>")).toBe(true);
    expect(user).toContain("So how would you price this for us?");
  });

  it("[conductor-mode] user context rides <user_script>; RAG grounding rides <user_memory>", async () => {
    // The trust-grade mapping at the conductor seam: deps.userContext is the
    // user's own instructions (script-grade), RAG snippets are facts-grade —
    // proven on the recorded request, not on an argument being passed along.
    const provider = makeMockProvider("google", {
      firstTokenDelayMs: 10,
      events: [tok("Answer"), DONE],
    });
    const rag = {
      query: () =>
        Promise.resolve({
          snippets: [
            { header: "2026-08-02 call", content: "They pushed on timeline." },
          ],
        }),
    } as unknown as RagService;
    const conductor = createLiveConductor({
      send: () => undefined,
      router: makeRouter([provider], liveLlmConfig()),
      config: CONFIG,
      autoSuggest: true,
      userId: "user-1",
      userContext: "Always anchor on the rollout.",
      rag,
    });
    conductor.onFinal("So how would you price this for us?", "them");
    await vi.advanceTimersByTimeAsync(500);

    const user =
      provider.calls[0]?.request.messages.find((m) => m.role === "user")
        ?.content ?? "";
    expect(user).toContain(
      "<user_script>\nAlways anchor on the rollout.\n</user_script>",
    );
    expect(user).toContain(
      "<user_memory>\n2026-08-02 call\nThey pushed on timeline.\n</user_memory>",
    );
  });
});
