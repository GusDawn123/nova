import { z } from "zod";

/**
 * Environment contract, parsed once at boot. Keep this to what the server
 * actually needs today (YAGNI) — grow it as real config appears.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
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
  // STT vendor keys (Phase 3.5). OPTIONAL: the server boots without them — the
  // STT engine simply has no vendors and a live session surfaces a typed error
  // instead of transcribing. ASSEMBLYAI_API_KEY selects the primary vendor,
  // DEEPGRAM_API_KEY the fallback (fixed primary-first order). Consumed only via
  // `modules/stt/vendors.ts` (re-parsed there at its own boundary); kept here so
  // the central env contract documents every variable the server reads. Secrets —
  // never logged, never in the repo.
  ASSEMBLYAI_API_KEY: z.string().min(1).optional(),
  DEEPGRAM_API_KEY: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Pure parse of an env-shaped object. Returns a zod result so callers (and
 * tests) can inspect failures without side effects.
 */
export function parseEnv(source: NodeJS.ProcessEnv) {
  return envSchema.safeParse(source);
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
