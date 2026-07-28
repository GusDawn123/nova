import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFallbackNotes, type MeetingNotes } from "@nova/shared";

import { createLiveNotesStore, type LiveNotesStore } from "./live-notes.js";

/**
 * `LiveNotesStore` integration proof against the LIVE local Supabase Postgres
 * (Phase 8, docs/DESIGN/live-notes.md §7). The load-bearing case is the OPTIMISTIC
 * `rev` GUARD: the notes conductor writes ~150 times per call, and the guard is the
 * only thing standing between a late/duplicated fold and an hour of accrued notes
 * being overwritten by stale state.
 *
 * Self-skips unless the stack env is present (roles.integration house style).
 */

const dbUrl = process.env.SUPABASE_DB_URL;
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasStack = Boolean(dbUrl && url && serviceRoleKey);

/** A schema-valid v2 preview; `source: "live"` is what the conductor writes. */
function livePreview(title: string): MeetingNotes {
  return { ...buildFallbackNotes(title), source: "live" };
}

describe.skipIf(!hasStack)("LiveNotesStore (local stack)", () => {
  let pool: Pool;
  let admin: ReturnType<typeof createClient>;
  let store: LiveNotesStore;
  let userId: string;
  let otherUserId: string;
  let meetingId: string;

  /** A fresh meeting owned by `userId`, so each test starts with no live_notes row. */
  async function newMeeting(): Promise<string> {
    const res = await pool.query<{ id: string }>(
      `insert into meetings (user_id, title) values ($1, $2) returning id`,
      [userId, `live-notes-${randomUUID()}`],
    );
    const id = res.rows[0]?.id;
    if (id === undefined) throw new Error("meeting insert returned no id");
    return id;
  }

  beforeAll(async () => {
    if (!dbUrl || !url || !serviceRoleKey) throw new Error("stack env missing");
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    store = createLiveNotesStore(pool);
    admin = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    for (const label of ["owner", "other"]) {
      const created = await admin.auth.admin.createUser({
        email: `live-notes-${label}-${randomUUID()}@nova.test`,
        password: `Pw-${randomUUID()}`,
        email_confirm: true,
      });
      if (created.error)
        throw new Error(`createUser: ${created.error.message}`);
      if (label === "owner") userId = created.data.user.id;
      else otherUserId = created.data.user.id;
    }
  });

  afterAll(async () => {
    // Child-first, matching the FK order (live_notes -> meetings -> auth user).
    for (const id of [userId, otherUserId]) {
      await pool.query(`delete from live_notes where user_id = $1`, [id]);
      await pool.query(`delete from meetings where user_id = $1`, [id]);
      await admin.auth.admin.deleteUser(id);
    }
    await pool.end();
  });

  beforeAll(async () => {
    meetingId = await newMeeting();
  });

  it("[live-notes] reads null when the meeting has no live notes yet", async () => {
    const fresh = await newMeeting();
    await expect(store.readLiveNotes(fresh, userId)).resolves.toBeNull();
  });

  it("[live-notes] round-trips a v2 notes object through jsonb unchanged", async () => {
    const notes = livePreview("Acme renewal");
    const written = await store.upsertLiveNotes({
      meetingId,
      userId,
      notes,
      rev: 1,
    });

    expect(written).toEqual({ status: "written", rev: 1 });

    const read = await store.readLiveNotes(meetingId, userId);
    // Deep equality, not just "parses": a jsonb round trip that silently dropped
    // or reordered a field would still parse.
    expect(read?.notes).toEqual(notes);
    expect(read?.rev).toBe(1);
    expect(read?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("[live-notes] a higher rev wins and replaces the stored notes", async () => {
    const next = livePreview("Acme renewal — updated");
    const res = await store.upsertLiveNotes({
      meetingId,
      userId,
      notes: next,
      rev: 2,
    });

    expect(res).toEqual({ status: "written", rev: 2 });
    const read = await store.readLiveNotes(meetingId, userId);
    expect(read?.notes.title).toBe("Acme renewal — updated");
    expect(read?.rev).toBe(2);
  });

  it.each([2, 1])(
    "[live-notes-rev-guard] a rev of %s is stale against the stored rev 2 and writes nothing",
    async (rev) => {
      // THE guard. An equal rev must lose too, not just a lower one — a retried
      // fold carries the same rev and must not clobber a newer one.
      const clobber = livePreview("STALE — must never land");
      const res = await store.upsertLiveNotes({
        meetingId,
        userId,
        notes: clobber,
        rev,
      });

      expect(res).toEqual({ status: "stale" });

      const read = await store.readLiveNotes(meetingId, userId);
      expect(read?.rev).toBe(2);
      expect(read?.notes.title).toBe("Acme renewal — updated");
    },
  );

  it("[live-notes] a soft-deleted row reads as null (RULES §3)", async () => {
    const tombstoned = await newMeeting();
    await store.upsertLiveNotes({
      meetingId: tombstoned,
      userId,
      notes: livePreview("Tombstoned"),
      rev: 1,
    });
    await pool.query(
      `update live_notes set deleted_at = now() where meeting_id = $1`,
      [tombstoned],
    );

    await expect(store.readLiveNotes(tombstoned, userId)).resolves.toBeNull();
  });

  it("[live-notes] a foreign user reads null even with the right meeting id", async () => {
    // The store scopes by user_id in SQL, so a caller that skipped its own
    // ownership check still cannot read across tenants.
    await expect(
      store.readLiveNotes(meetingId, otherUserId),
    ).resolves.toBeNull();
  });

  it("[live-notes] a malformed notes object is rejected before it reaches Postgres", async () => {
    const malformed = { version: 2, title: "no other fields" };
    const solo = await newMeeting();

    await expect(
      store.upsertLiveNotes({
        meetingId: solo,
        userId,
        // why: the write-side parse is exactly the guard being proven, so the
        // cast is deliberate — slice 3 feeds this from an LLM fold.
        notes: malformed as unknown as MeetingNotes,
        rev: 1,
      }),
    ).rejects.toThrow();

    // Nothing was written — "malformed JSON is unrepresentable in the DB".
    const after = await pool.query(
      `select 1 from live_notes where meeting_id = $1`,
      [solo],
    );
    expect(after.rowCount).toBe(0);
  });
});
