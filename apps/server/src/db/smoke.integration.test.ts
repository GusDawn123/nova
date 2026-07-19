import { describe, expect, it } from "vitest";

import { getSmokeNote, insertSmokeNote } from "./smoke.js";

/**
 * Server <-> Postgres round trip against the RUNNING local Supabase stack.
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment, sourced
 * from `supabase status -o env` (see .env.example). When SUPABASE_URL is absent
 * (no stack, e.g. a plain `npm run test` or CI's Test step) the whole suite is
 * skipped so the default gate stays green without a database.
 */
const hasStack = Boolean(process.env.SUPABASE_URL);

describe.skipIf(!hasStack)("_smoke round trip (local stack)", () => {
  it("inserts a note and reads it back", async () => {
    const note = `smoke-${Date.now().toString()}`;

    const inserted = await insertSmokeNote(note);
    expect(inserted.note).toBe(note);
    expect(inserted.deleted_at).toBeNull();

    const fetched = await getSmokeNote(inserted.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(inserted.id);
    expect(fetched?.note).toBe(note);
  });

  it("excludes soft-deleted rows from live reads", async () => {
    const inserted = await insertSmokeNote(`soft-del-${Date.now().toString()}`);

    // A live read finds it while deleted_at is null...
    expect(await getSmokeNote(inserted.id)).not.toBeNull();

    // ...soft-delete it, then the same live read (deleted_at is null) skips it.
    const { getSupabaseClient } = await import("./client.js");
    const { error } = await getSupabaseClient()
      .from("_smoke")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", inserted.id);
    expect(error).toBeNull();

    expect(await getSmokeNote(inserted.id)).toBeNull();
  });
});
