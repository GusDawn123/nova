import { describe, expect, it, vi } from "vitest";

import type { ServerLiveEvent } from "@nova/shared";

import {
  createLlmRouter,
  createProvidersFromEnv,
  liveLlmConfig,
  type LlmProviderEnv,
} from "../llm/index.js";

import { conductorConfigSchema } from "./conductor-config.js";
import { createLiveConductor } from "./conductor.js";

/**
 * KEY-GATED live RELEVANCE gate (playbook Phase 7 VERIFY). Ten hand-labeled
 * question moments are driven through the REAL conductor → REAL live-tier router
 * (createProvidersFromEnv); the streamed suggestion must reference the expected
 * topic by a keyword rubric (not vibes) in ≥ 7/10. Runs ONLY with an LLM key
 * (`describe.skipIf`) — same convention as the Phase 2 smoke / Phase 5 accuracy
 * gates; keyless CI/local runs skip cleanly while the mock suites carry behavior.
 *
 * ANTHROPIC IS DISABLED (cost decision) — the live cascade runs on OpenAI +
 * Google (+ Groq if keyed). Do not re-enable anthropic here.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 30_000 });

function providerEnv(): LlmProviderEnv {
  const env: LlmProviderEnv = {};
  // Deliberately NOT reading ANTHROPIC_API_KEY (disabled by decision).
  if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (process.env.GOOGLE_API_KEY) env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  if (process.env.GROQ_API_KEY) env.GROQ_API_KEY = process.env.GROQ_API_KEY;
  return env;
}

const canRun = Boolean(
  process.env.OPENAI_API_KEY || process.env.GOOGLE_API_KEY,
);

/** Each moment: the question utterance + ANY-of expected topic keywords. */
const MOMENTS: readonly { q: string; keywords: string[] }[] = [
  {
    q: "What's the difference between REST and GraphQL APIs?",
    keywords: ["rest", "graphql", "endpoint", "query", "schema"],
  },
  {
    q: "Can you explain what Kubernetes is used for?",
    keywords: ["kubernetes", "container", "orchestrat", "cluster", "pod"],
  },
  {
    q: "How does OAuth 2.0 authentication actually work?",
    keywords: ["oauth", "token", "authoriz", "grant", "client"],
  },
  {
    q: "So we're building our whole data platform on top of Snowflake",
    keywords: ["snowflake", "data", "warehouse", "cloud", "analyt"],
  },
  {
    q: "What are the main benefits of using TypeScript over JavaScript?",
    keywords: ["typescript", "type", "javascript", "static", "safety"],
  },
  {
    q: "mostly did infrastructure automation work with Terraform last year",
    keywords: ["terraform", "infrastructure", "provision", "cloud", "iac"],
  },
  {
    q: "How would you handle rate limiting in a distributed system?",
    keywords: ["rate", "limit", "throttl", "distributed", "bucket"],
  },
  {
    q: "What's a good approach to database indexing for read performance?",
    keywords: ["index", "database", "query", "performance", "b-tree"],
  },
  {
    q: "Can you walk me through how a hash table works under the hood?",
    keywords: ["hash", "table", "key", "bucket", "collision"],
  },
  {
    q: "Tell me about the tradeoffs between SQL and NoSQL databases",
    keywords: ["sql", "nosql", "relational", "document", "schema"],
  },
];

/** Drive one question moment through the conductor; resolve the final suggestion text. */
function runMoment(
  router: ReturnType<typeof createLlmRouter>,
  question: string,
): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve(text);
    };
    const conductor = createLiveConductor({
      send: (e: ServerLiveEvent) => {
        if (e.type === "suggestion.delta") text += e.text;
        if (e.type === "suggestion.done") done();
        if (e.type === "suggestion.discard") done();
      },
      router,
      // Relevance, not latency: give the real network a generous first-token window.
      config: conductorConfigSchema.parse({
        speculationEnabled: false,
        firstTokenDeadlineMs: 30_000,
      }),
    });
    conductor.onFinal(question, "them");
    // Safety net so a hung provider never wedges the suite.
    setTimeout(done, 60_000);
  });
}

describe.skipIf(!canRun)("modules/live [relevance] live suggestion relevance", () => {
  it("[relevance] references the expected topic in >= 7/10 moments", async () => {
    const providers = createProvidersFromEnv(providerEnv());
    expect(providers.length).toBeGreaterThan(0);
    const router = createLlmRouter({ providers, config: liveLlmConfig() });

    let hits = 0;
    const misses: string[] = [];
    for (const moment of MOMENTS) {
      const suggestion = (await runMoment(router, moment.q)).toLowerCase();
      const hit = moment.keywords.some((k) => suggestion.includes(k));
      if (hit) hits += 1;
      else misses.push(`${moment.q} :: got="${suggestion.slice(0, 120)}"`);
    }

    console.log(
      `[relevance] ${String(hits)}/10 moments referenced the expected topic (bar >= 7)`,
    );
    for (const m of misses) console.log(`[relevance] MISS ${m}`);
    expect(hits).toBeGreaterThanOrEqual(7);
  });
});
