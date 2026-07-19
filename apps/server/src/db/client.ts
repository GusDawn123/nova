import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { loadEnv } from "../env.js";
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

let cached: Db | undefined;

/**
 * Lazily build and memoise the client from env. Throws a clear error when the
 * Supabase env vars are absent — call this only on code paths that genuinely
 * need the DB, never at boot (so /health works without a database).
 */
export function getSupabaseClient(): Db {
  if (cached) return cached;

  const env = loadEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Supabase is not configured: set SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY to use the database.",
    );
  }

  cached = createSupabaseClient({
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  });
  return cached;
}
