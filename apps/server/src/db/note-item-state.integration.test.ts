import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createNoteItemStateStore,
  type NoteItemStateStore,
} from "./note-item-state.js";

/**
 * `note_item_state` STORE behaviour against real Postgres (Phase 8.5,
 * `docs/DESIGN/notes-ui.md` §6.3). Complements the RLS suite beside it: that one
 * proves what a user's own JWT may do, this one proves what the SERVICE-ROLE pool
 * does — the connection RLS does not constrain at all.
 *
 * The case that matters is the conflict target. The primary key is
 * (meeting_id, item_id) with NO user column in it, so `on conflict … do update`
 * would happily rewrite another user's row unless the DO UPDATE carries an owner
 * predicate of its own. Route-level ownership makes that unreachable today; this
 * pins it at the layer that cannot be refactored away upstream.
 *
 * Self-skips without the stack env (isolation-suite convention).
 */

const dbUrl = process.env.SUPABASE_DB_URL;
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasStack = Boolean(dbUrl && url && serviceRoleKey);

const noPersist = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

interface StateRow {
  user_id: string;
  item_text: string;
  completed_at: Date | null;
}

describe.skipIf(!hasStack)("note_item_state store (local stack)", () => {
  let pool: Pool;
  let admin: ReturnType<typeof createClient>;
  let store: NoteItemStateStore;

  let userAId: string;
  let userBId: string;
  const userIds: string[] = [];
  /** A's meeting — the row both users' writes target. */
  let meetingId: string;

  const NOW = new Date("2026-07-28T12:00:00Z");
  const LATER = new Date("2026-07-28T13:00:00Z");

  async function createUser(label: string): Promise<string> {
    const created = await admin.auth.admin.createUser({
      email: `nis-store-${label}-${randomUUID()}@nova.test`,
      password: `Pw-${randomUUID()}`,
      email_confirm: true,
    });
    if (created.error) throw new Error(`createUser: ${created.error.message}`);
    return created.data.user.id;
  }

  async function readRow(): Promise<StateRow | undefined> {
    const res = await pool.query<StateRow>(
      `select user_id, item_text, completed_at
         from note_item_state where meeting_id = $1 and item_id = 'a1'`,
      [meetingId],
    );
    return res.rows[0];
  }

  beforeAll(async () => {
    if (!dbUrl || !url || !serviceRoleKey) throw new Error("stack env missing");
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    admin = createClient(url, serviceRoleKey, noPersist);
    store = createNoteItemStateStore(pool);

    userAId = await createUser("a");
    userIds.push(userAId);
    userBId = await createUser("b");
    userIds.push(userBId);

    const meeting = await pool.query<{ id: string }>(
      `insert into meetings (user_id, title, started_at, ended_at, notes_status)
       values ($1, 'Northwind discovery', now(), now(), 'completed') returning id`,
      [userAId],
    );
    const id = meeting.rows[0]?.id;
    if (id === undefined) throw new Error("meeting insert returned no id");
    meetingId = id;

    await store.setCompleted({
      meetingId,
      userId: userAId,
      itemId: "a1",
      itemText: "Send the scope comparison.",
      completed: true,
      now: NOW,
    });
  });

  afterAll(async () => {
    for (const id of userIds) {
      await pool.query("delete from note_item_state where user_id = $1", [id]);
      await pool.query("delete from meetings where user_id = $1", [id]);
      await admin.auth.admin.deleteUser(id);
    }
    await pool.end();
  });

  it("a cross-user conflict REJECTS the write and leaves the row untouched", async () => {
    // B aims at A's (meeting_id, item_id). The PK conflict fires; the DO UPDATE's
    // owner predicate refuses it. A silent no-op would be worse than the throw:
    // the caller would believe the checkmark landed.
    await expect(
      store.setCompleted({
        meetingId,
        userId: userBId,
        itemId: "a1",
        itemText: "B's forged text.",
        completed: false,
        now: LATER,
      }),
    ).rejects.toThrow(/no row/i);

    const row = await readRow();
    expect(row?.user_id).toBe(userAId);
    expect(row?.item_text).toBe("Send the scope comparison.");
    expect(row?.completed_at).not.toBeNull();
  });

  it("the OWNER's re-write still updates the same row (positive control)", async () => {
    // A predicate that is too tight breaks the feature it protects, so prove the
    // ordinary uncheck-then-recheck path still works on the same conflict target.
    await store.setCompleted({
      meetingId,
      userId: userAId,
      itemId: "a1",
      itemText: "Send Dana the scope comparison.",
      completed: false,
      now: LATER,
    });

    const row = await readRow();
    expect(row?.user_id).toBe(userAId);
    expect(row?.item_text).toBe("Send Dana the scope comparison.");
    // An uncheck is a durable fact: the row stays, completed_at goes null.
    expect(row?.completed_at).toBeNull();

    const rows = await store.readForMeeting(meetingId, userAId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.completedAt).toBeNull();
  });
});
