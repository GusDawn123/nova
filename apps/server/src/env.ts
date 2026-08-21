import { z } from "zod";

/**
 * Environment contract, parsed once at boot. Keep this to what the server
 * actually needs today (YAGNI) — grow it as real config appears.
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default("127.0.0.1"),
  // Supabase is OPTIONAL: the server must boot (and serve /health) without a DB.
  // The db adapter demands these lazily and fails loudly only when actually used.
  // Both are absent together in a no-DB boot; the adapter checks for that.
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  // Anon (publishable) key. The server itself never uses it — it is consumed only
  // by the RLS isolation integration tests, which build per-user authenticated
  // clients (createClient(url, anonKey) + signInWithPassword) to prove Postgres
  // RLS, not app code, enforces tenant isolation. Optional for the same reason as
  // the two above: absent in a no-DB boot.
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
  // LLM provider keys (Phase 2) — all OPTIONAL. The server boots without them; the
  // llm module's `createProvidersFromEnv` builds only the providers whose key is
  // present, so a subset (or none) is a valid configuration. Never committed.
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  GOOGLE_API_KEY: z.string().min(1).optional(),
  GROQ_API_KEY: z.string().min(1).optional(),
  // STT vendor keys (Phase 3.5). OPTIONAL: the server boots without them — the
  // STT engine simply has no vendors and a live session surfaces a typed error
  // instead of transcribing. ASSEMBLYAI_API_KEY selects the primary vendor,
  // DEEPGRAM_API_KEY the fallback (fixed primary-first order). Consumed only via
  // `modules/stt/vendors.ts` (re-parsed there at its own boundary); kept here so
  // the central env contract documents every variable the server reads. Secrets —
  // never logged, never in the repo.
  ASSEMBLYAI_API_KEY: z.string().min(1).optional(),
  DEEPGRAM_API_KEY: z.string().min(1).optional(),
  // RAG embeddings vendor (Phase 4). OPTIONAL: keyless deploys degrade to a typed
  // `RAG_NOT_CONFIGURED` (ingest + live retrieval skip cleanly), never a crash —
  // same posture as the STT/LLM keys. Consumed only via `modules/rag/adapters/
  // voyage.ts` (re-parsed there at its own boundary). Company-held secret: never
  // logged, never in the repo, never shipped to the mobile app.
  VOYAGE_API_KEY: z.string().min(1).optional(),
  // Direct Postgres connection for the pgvector RAG adapter (adr-0005 §4). The hot
  // retrieval path bypasses PostgREST and talks to Postgres over a `pg` Pool for
  // latency, so it needs a libpq-style connection string. OPTIONAL: the pgvector
  // store demands it lazily and throws `RAG_NOT_CONFIGURED` on first use when
  // absent (like the Supabase db client). Local stack default:
  // `postgresql://postgres:postgres@127.0.0.1:54322/postgres` (`supabase status`
  // → DB_URL). Treated as a secret (carries the DB password); never logged.
  SUPABASE_DB_URL: z.string().url().optional(),
  // Post-call notes worker switch (Phase 5). OFF by default: the durable queue
  // machinery (worker poll loop + lease reaper + eager-enqueue seam) only runs when
  // this is the string "true" AND SUPABASE_DB_URL is set — the same explicit-opt-in,
  // off-in-tests/keyless-boots posture the RAG indexer takes. The stale-call reaper
  // is gated separately (on SUPABASE_DB_URL alone), since it also feeds RAG.
  NOTES_WORKER_ENABLED: z.string().optional(),
  // RevenueCat webhook shared secret (Phase 6, adr-0007 §7). OPTIONAL: when unset
  // the `POST /webhooks/revenuecat` route is NOT registered at all (the seam stays
  // dark until billing goes live in Phase 8). When set, the webhook requires
  // `Authorization: Bearer <this value>` (constant-time compared). Secret — never
  // logged, never in the repo, configured in the RevenueCat dashboard.
  REVENUECAT_WEBHOOK_TOKEN: z.string().min(1).optional(),
  // Prompt composer switch (2026-08-20 prompt-stack redesign). OFF by default:
  // the conductor keeps the legacy assembleMeeting path (byte-identical
  // fallback) unless this is the string "true" — the migration rule is
  // `composeSay(...) ?? legacy` behind this flag, and unsetting it is the
  // kill-switch that restores the old prompts exactly.
  PROMPT_COMPOSER_ENABLED: z.string().optional(),
  // Dev-only live-answer ledger opt-in (2026-08-19). HARD-OFF by default —
  // this sink writes conversation content (a deliberate RULES §6 exception),
  // so it exists only behind this explicit flag and must never be enabled in
  // production. `1`/`true` → `.dev/llm-transcript.jsonl`; any other non-empty
  // value is the path itself. Consumed via `debug-transcript.ts` (its own
  // boundary); declared here so the env contract documents every variable the
  // server reads — it predates this line and was the one undocumented flag.
  LLM_DEBUG_TRANSCRIPT: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Is the notes worker explicitly enabled? Read directly off the environment at the
 * wiring site (like the RAG indexer's `VOYAGE_API_KEY` gate) so a background feature
 * never starts under test or on a boot that did not opt in.
 */
export function isNotesWorkerEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.NOTES_WORKER_ENABLED === "true";
}

/**
 * Is the prompt composer explicitly enabled? Same posture and shape as the
 * notes-worker gate: read at the wiring seam, only the literal string "true"
 * opts in, so a keyless/CI/test boot always rides the legacy prompt path.
 */
export function isPromptComposerEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.PROMPT_COMPOSER_ENABLED === "true";
}

/**
 * Pure parse of an env-shaped object. Returns a zod result so callers (and
 * tests) can inspect failures without side effects.
 *
 * Blank means absent: `.env` files routinely keep a key with no value
 * (`GROQ_API_KEY=`) to mean "not configured", and `--env-file` loads that as
 * the empty string — which would trip every `min(1).optional()` above and
 * kill the boot over a key the deploy deliberately left unset.
 */
export function parseEnv(source: NodeJS.ProcessEnv) {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(
      ([, value]) => value !== undefined && value.trim() !== "",
    ),
  );
  return envSchema.safeParse(cleaned);
}

/**
 * Boot-time loader: parse `process.env` and, on failure, print a structured
 * error and exit BEFORE the server binds a port. Never logs raw values.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = parseEnv(source);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    console.error(
      JSON.stringify({
        level: "fatal",
        msg: "Invalid environment configuration",
        issues,
      }),
    );
    process.exit(1);
  }

  return result.data;
}
