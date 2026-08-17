import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maybeCreateLiveConductorFactory } from "./metering-wiring.js";

// Pass-through spy on the provider factory so the wiring test can assert the
// OPTIONS the production call supplies (the live 4096 ceiling) — the providers
// themselves are still real constructions (no vendor call happens at build).
const factorySpy = vi.hoisted(() => ({
  calls: [] as unknown[][],
}));
vi.mock("./modules/llm/index.js", async (importActual) => {
  const actual = await importActual<typeof import("./modules/llm/index.js")>();
  return {
    ...actual,
    createProvidersFromEnv: (
      ...args: Parameters<typeof actual.createProvidersFromEnv>
    ) => {
      factorySpy.calls.push(args);
      return actual.createProvidersFromEnv(...args);
    },
  };
});

/**
 * [metering-wiring] The fail-CLOSED posture of the live conductor factory.
 *
 * adr-0007 / CLAUDE.md carry a hard prohibition: no unmetered path to a paid
 * vendor API. The live factory constructs an LLM router, so it must refuse to
 * exist when the metering service cannot — otherwise a deployment with vendor keys
 * but no `usage_events` DB streams real tokens that never land on the ledger.
 *
 * These are pure env-gate tests: no network, no DB. Constructing a provider does
 * not call the vendor, and every case here asserts the factory is NOT built.
 */

const LLM_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
] as const;
/** Every env var `isUsageEventsConfigured` reads, so a test can unset the DB. */
const DB_KEYS = ["SUPABASE_DB_URL", "DATABASE_URL"] as const;

let app: FastifyInstance;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  app = Fastify({ logger: false });
  saved = {};
  for (const key of [...LLM_KEYS, ...DB_KEYS]) {
    saved[key] = process.env[key];
    // Reflect.deleteProperty, not `delete env[key]`: the dynamic-key form is a
    // lint error, and assigning undefined would store the STRING "undefined".
    Reflect.deleteProperty(process.env, key);
  }
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  await app.close();
});

describe("[metering-wiring] the live copilot factory fails closed", () => {
  it("is undefined with an LLM key but NO usage-events DB (no unmetered path)", () => {
    // The dangerous deployment: vendor keys present, ledger absent. Before the
    // fix this returned a working factory whose `meter` spread was empty, so
    // every streamed suggestion (and its Voyage grounding) went unbilled.
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";

    expect(maybeCreateLiveConductorFactory(app)).toBeUndefined();
  });

  it("is undefined with no LLM key at all (the keyless posture)", () => {
    expect(maybeCreateLiveConductorFactory(app)).toBeUndefined();
  });

  it("hands the live provider factory the 4096 output ceiling", () => {
    // Even on the fail-closed path (no DB), the provider construction happens
    // first — which is exactly the call whose options this pins: drop the
    // `maxOutputTokens: 4096` from metering-wiring and this test fails.
    factorySpy.calls.length = 0;
    process.env.GOOGLE_API_KEY = "test-not-a-real-key";

    maybeCreateLiveConductorFactory(app);

    expect(factorySpy.calls).toHaveLength(1);
    expect(factorySpy.calls[0]?.[1]).toEqual({ maxOutputTokens: 4096 });
  });
});
