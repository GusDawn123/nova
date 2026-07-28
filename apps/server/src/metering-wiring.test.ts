import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  maybeCreateLiveConductorFactory,
  maybeCreateLiveNotesConductorFactory,
} from "./metering-wiring.js";

/**
 * [metering-wiring] The fail-CLOSED posture of the live conductor factories.
 *
 * adr-0007 / CLAUDE.md carry a hard prohibition: no unmetered path to a paid
 * vendor API. Both live factories construct an LLM router, so BOTH must refuse to
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
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
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
});

describe("[metering-wiring] the live notes factory fails closed", () => {
  it("is undefined with an LLM key but NO usage-events DB", () => {
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";

    expect(maybeCreateLiveNotesConductorFactory(app)).toBeUndefined();
  });

  it("is undefined with no LLM key at all", () => {
    expect(maybeCreateLiveNotesConductorFactory(app)).toBeUndefined();
  });
});
