import { getSupabaseClient } from "./client.js";
import { smokeRowSchema, type SmokeRow } from "./schema.js";

/**
 * Narrow data-access functions for the `_smoke` scaffold table. These prove the
 * server -> Postgres round trip and are the surface the integration test drives.
 * Callers pass primitives and get back zod-parsed rows — the raw SDK never leaks.
 */

const SMOKE_TABLE = "_smoke";

/** Insert a note and return the created row. */
export async function insertSmokeNote(note: string): Promise<SmokeRow> {
  const { data, error } = await getSupabaseClient()
    .from(SMOKE_TABLE)
    .insert({ note })
    .select()
    .single();

  if (error) {
    throw new Error(`insertSmokeNote failed: ${error.message}`);
  }

  // Re-validate at runtime even though the SDK types the row — types are not a
  // runtime guarantee against a schema/driver surprise (RULES §1).
  return smokeRowSchema.parse(data);
}

/**
 * Fetch a single live (not soft-deleted) `_smoke` row by id. Returns null when no
 * matching live row exists — soft-deleted rows (`deleted_at is not null`) are
 * excluded, the standard read convention (RULES §3).
 */
export async function getSmokeNote(id: string): Promise<SmokeRow | null> {
  const { data, error } = await getSupabaseClient()
    .from(SMOKE_TABLE)
    .select()
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    throw new Error(`getSmokeNote failed: ${error.message}`);
  }

  return data ? smokeRowSchema.parse(data) : null;
}
