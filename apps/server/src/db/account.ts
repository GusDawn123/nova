import { getSupabaseClient } from "./client.js";
import { deletionRequestRowSchema, type DeletionRequestRow } from "./schema.js";

/**
 * Narrow data-access surface for account deletion. Like the `_smoke` adapter,
 * callers pass primitives and get back zod-parsed rows — the raw Supabase SDK
 * never leaks past this module.
 */

const DELETION_REQUESTS_TABLE = "deletion_requests";
const PROFILES_TABLE = "profiles";

/**
 * Enqueue an account-deletion request for `userId` and tombstone their profile.
 *
 * Steps (service-role client — bypasses RLS):
 *   (a) Idempotent enqueue: if an unprocessed (`processed_at is null`) request
 *       already exists for the user, return it instead of inserting a duplicate.
 *       The check + insert are not one transaction, but this path is service-role
 *       only and never runs concurrently for a single user (the caller is one
 *       request handler), so a duplicate race is not a practical concern here.
 *   (b) Soft-delete the profile (`deleted_at = now()`) if not already set —
 *       the RULES §3 tombstone; the row survives for the async purge worker.
 *   (c) Best-effort session revocation via the GoTrue admin API. Requires the
 *       caller's access token (`accessToken`); when it is absent or revocation
 *       fails we swallow the error — the user's existing access tokens then
 *       remain valid until their `exp`, which is acceptable for a queued delete.
 *
 * Returns the (new or pre-existing) queued row.
 */
export async function queueAccountDeletion(
  userId: string,
  accessToken?: string,
): Promise<DeletionRequestRow> {
  const client = getSupabaseClient();

  // (a) Reuse an existing pending request if there is one (idempotency).
  const existing = await client
    .from(DELETION_REQUESTS_TABLE)
    .select()
    .eq("user_id", userId)
    .is("processed_at", null)
    .limit(1)
    .maybeSingle();
  if (existing.error) {
    throw new Error(
      `queueAccountDeletion lookup failed: ${existing.error.message}`,
    );
  }

  let row: DeletionRequestRow;
  if (existing.data) {
    row = deletionRequestRowSchema.parse(existing.data);
  } else {
    const inserted = await client
      .from(DELETION_REQUESTS_TABLE)
      .insert({ user_id: userId })
      .select()
      .single();
    if (inserted.error) {
      throw new Error(
        `queueAccountDeletion insert failed: ${inserted.error.message}`,
      );
    }
    row = deletionRequestRowSchema.parse(inserted.data);
  }

  // (b) Tombstone the profile if it is not already tombstoned. Scoping the
  // update to `deleted_at is null` keeps the original deletion timestamp stable
  // when the endpoint is called more than once.
  const tombstone = await client
    .from(PROFILES_TABLE)
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", userId)
    .is("deleted_at", null);
  if (tombstone.error) {
    throw new Error(
      `queueAccountDeletion tombstone failed: ${tombstone.error.message}`,
    );
  }

  // (c) Best-effort: revoke the user's sessions. `admin.signOut(jwt, 'global')`
  // invalidates every refresh token for the session behind that JWT. We never
  // let a revocation failure fail the deletion — the queue row is the source of
  // truth and the access token expires on its own.
  await revokeSessionsBestEffort(accessToken);

  return row;
}

async function revokeSessionsBestEffort(accessToken?: string): Promise<void> {
  if (accessToken === undefined) return;
  try {
    await getSupabaseClient().auth.admin.signOut(accessToken, "global");
  } catch {
    // Swallow: tokens remain valid until `exp`; the purge still proceeds.
  }
}
