import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maybeCreateLiveConductorFactory } from "./metering-wiring.js";

// Pass-through spy on the provider factory so the wiring test can assert the
// OPTIONS the production call supplies (the live 4096 ceiling) â€” the providers
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

// The pre-warm is a REAL router call in production â€” mocked here so the wiring
// test can assert the per-session fire without any network attempt.
const prewarmSpy = vi.hoisted(() => ({
  calls: [] as unknown[],
}));
vi.mock("./modules/live/prewarm.js", () => ({
  prewarmPromptCache: (deps: unknown) => {
    prewarmSpy.calls.push(deps);
    return Promise.resolve();
  },
}));

/**
 * [metering-wiring] The fail-CLOSED posture of the live conductor factory.
 *
 * adr-0007 / CLAUDE.md carry a hard prohibition: no unmetered path to a paid
 * vendor API. The live factory constructs an LLM router, so it must refuse to
 * exist when the metering service cannot â€” otherwise a deployment with vendor keys
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
/** The composer flag â€” cleared per test so the legacy path is the baseline. */
const FLAG_KEYS = ["PROMPT_COMPOSER_ENABLED"] as const;

let app: FastifyInstance;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  app = Fastify({ logger: false });
  saved = {};
  for (const key of [...LLM_KEYS, ...DB_KEYS, ...FLAG_KEYS]) {
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

  it("hands the live provider factory temperature 0.3 and NO output cap", () => {
    // Gustavo, 2026-08-17: no product caps on answer length â€” caps squeezed
    // the mandated comments/detail out of code answers. Even on the
    // fail-closed path (no DB), provider construction happens first, which is
    // exactly the call whose options this pins: reintroduce a
    // `maxOutputTokens` here and this test fails. Temperature 0.3 is the
    // Natively-reference live setting (2026-08-19) â€” the ONLY option passed.
    factorySpy.calls.length = 0;
    process.env.GOOGLE_API_KEY = "test-not-a-real-key";

    maybeCreateLiveConductorFactory(app);

    expect(factorySpy.calls).toHaveLength(1);
    expect(factorySpy.calls[0]?.[1]).toEqual({
      temperature: 0.3,
      // The live Google lane rides gemini-3.7-flash (2026-08-20 picker);
      // still NO maxOutputTokens — the no-cap pin this test exists for.
      modelOverrides: { google: "gemini-3.7-flash" },
    });
  });

  it("fires ONE metered prompt-cache pre-warm per session build", () => {
    // The Natively-reference pre-warm (2026-08-19): every conductor build â€”
    // one per accepted `session.start` â€” kicks off exactly one warm carrying
    // the live router and the per-call meter, so the first real ask lands on
    // a written prefix cache and the warm itself is billed like any call.
    prewarmSpy.calls.length = 0;
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    process.env.SUPABASE_DB_URL =
      "postgresql://nova:nova@127.0.0.1:54322/postgres";

    const factory = maybeCreateLiveConductorFactory(app);
    expect(factory).toBeDefined();
    const conductor = factory?.({
      send: () => undefined,
      userId: "user-1",
      meetingId: "meeting-1",
      mode: "general",
      liveModel: "gpt",
    });
    conductor?.dispose();

    expect(prewarmSpy.calls).toHaveLength(1);
    expect(prewarmSpy.calls[0]).toMatchObject({
      userId: "user-1",
      meetingId: "meeting-1",
    });
    const deps = prewarmSpy.calls[0] as {
      router?: unknown;
      meter?: unknown;
      stablePrefix?: string;
    };
    expect(deps.router).toBeDefined();
    expect(deps.meter).toBeDefined();
    // Flag unset â†’ the legacy prefix (prewarm's own default): no override rides.
    expect(deps.stablePrefix).toBeUndefined();
  });

  it("with PROMPT_COMPOSER_ENABLED the pre-warm heats the COMPOSED prefix", () => {
    // The kill-switch law's other half: flag on â†’ the session's real asks send
    // the composed prefix, so the warm must target that exact byte sequence.
    prewarmSpy.calls.length = 0;
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    process.env.SUPABASE_DB_URL =
      "postgresql://nova:nova@127.0.0.1:54322/postgres";
    process.env.PROMPT_COMPOSER_ENABLED = "true";

    const factory = maybeCreateLiveConductorFactory(app);
    const conductor = factory?.({
      send: () => undefined,
      userId: "user-1",
      meetingId: "meeting-1",
      mode: "general",
      liveModel: "gpt",
    });
    conductor?.dispose();

    expect(prewarmSpy.calls).toHaveLength(1);
    const deps = prewarmSpy.calls[0] as { stablePrefix?: string };
    expect(deps.stablePrefix).toBeDefined();
    expect(deps.stablePrefix).toContain('<active_mode name="sales">');
    expect(deps.stablePrefix).toContain("<final_check>");
  });

  it("a picked model maps to its cascade: grok leads, the rest fall back, groq never rides", () => {
    // The 2026-08-20 picker law: the session's model choice becomes a
    // providerOrder on every call — pre-warm included — with the picked
    // provider first and the other picker lanes behind it.
    prewarmSpy.calls.length = 0;
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    process.env.SUPABASE_DB_URL =
      "postgresql://nova:nova@127.0.0.1:54322/postgres";

    const factory = maybeCreateLiveConductorFactory(app);
    const conductor = factory?.({
      send: () => undefined,
      userId: "user-1",
      meetingId: "meeting-1",
      mode: "general",
      liveModel: "grok",
    });
    conductor?.dispose();

    const deps = prewarmSpy.calls[0] as { providerOrder?: readonly string[] };
    expect(deps.providerOrder).toEqual(["xai", "openai", "google"]);
  });
});
