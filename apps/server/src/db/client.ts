import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { type Database } from "./schema.js";

/**
 * The client parameterised with our minimal `Database` type, so `.from("_smoke")`
 * queries are typed end to end (no `any` widening, insert/update payloads checked).
 */
export type Db = SupabaseClient<Database>;

/**
 * Supabase adapter boundary.
 *
 * This is the ONLY module in the server that imports `@supabase/supabase-js`.
 * Routes/handlers and tests call the narrow functions in `./smoke.ts`; they never
 * touch the SDK directly (RULES: vendor SDKs stay behind an adapter). When the
 * real module structure lands, this moves under a module's adapters directory.
 */

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
}

/**
 * Pure factory: build a service-role client from explicit config. The
 * service_role key bypasses RLS, which is the intended posture for trusted
 * server-side writes. No session persistence — this is a stateless backend.
 */
export function createSupabaseClient(config: SupabaseConfig): Db {
  return createClient<Database>(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Raised when the Supabase env vars are absent or malformed on a DB code path.
 * A typed error (not `process.exit`) so callers — including vitest workers —
 * fail the operation instead of killing the whole process.
 */
export class SupabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupabaseConfigError";
  }
}

/**
 * The two env vars the DB adapter needs, parsed at the boundary. Kept local to
 * this module (not the boot env schema) so demanding the DB never triggers the
 * process-exiting boot loader.
 */
const supabaseEnvSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

/**
 * Presence-only check: are the Supabase env vars set + well-formed? Used by callers
 * that must decide whether to WIRE a DB-backed feature (e.g. transcript persistence)
 * without triggering the throwing {@link getSupabaseClient} on a keyless deploy.
 */
export function isSupabaseConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return supabaseEnvSchema.safeParse(env).success;
}

let cached: Db | undefined;

/**
 * Lazily build and memoise the client from env. Throws {@link SupabaseConfigError}
 * when the Supabase env vars are absent or invalid — call this only on code
 * paths that genuinely need the DB, never at boot (so /health works without a
 * database).
 */
export function getSupabaseClient(): Db {
  if (cached) return cached;

  const result = supabaseEnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new SupabaseConfigError(
      "Supabase is not configured: set SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY to use the database.",
    );
  }

  cached = createSupabaseClient({
    url: result.data.SUPABASE_URL,
    serviceRoleKey: result.data.SUPABASE_SERVICE_ROLE_KEY,
  });
  return cached;
}
