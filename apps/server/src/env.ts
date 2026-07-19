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
