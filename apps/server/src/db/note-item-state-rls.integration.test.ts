import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `public.note_item_state` RLS + grant posture proof (Phase 8.5,
 * `docs/DESIGN/notes-ui.md` §6.3; RULES §4.9 requires this in the same PR as the
 * policy). Writes are SERVER-AUTHORED: `authenticated` may SELECT its own live rows
 * and nothing else.
 *
 * Unlike profiles.role/plan or meetings.indexed_at there is no privilege-bearing
 * column here, so a client write grant would be *defensible* — the reason to route
 * writes through the server is that only the server can check the item id against
 * the meeting's current notes and supply `item_text` itself. These tests pin that
 * posture so a later convenience grant cannot quietly reopen it.
 *
 * Hits PostgREST DIRECTLY with a real user's JWT, so what is under test is the
 * Postgres policy/grant, not application code.
 */

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const hasStack = Boolean(url && serviceRoleKey && anonKey);

// MUST be `type` aliases — supabase-js constrains Row to Record<string, unknown>,
// which object-literal type aliases satisfy implicitly but interfaces do not; an
// interface here silently degrades every query result to `never`.
type StateRowShape = {
  meeting_id: string;
  user_id: string;
  item_id: string;
  item_text: string;
  completed_at: string | null;
  deleted_at: string | null;
};
type MeetingRowShape = {
  id: string;
  user_id: string;
  title: string;
  deleted_at: string | null;
};
type Database = {
  public: {
    Tables: {
      note_item_state: {
        Row: StateRowShape;
        Insert: Partial<StateRowShape> & {
          meeting_id: string;
          user_id: string;
          item_id: string;
          item_text: string;
        };
        Update: Partial<StateRowShape>;
        Relationships: [];
      };
      meetings: {
        Row: MeetingRowShape;
        Insert: Partial<MeetingRowShape> & { user_id: string; title: string };
        Update: Partial<MeetingRowShape>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

const noPersist = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

type TestUser = {
  id: string;
  client: SupabaseClient<Database>;
  meetingId: string;
};

describe.skipIf(!hasStack)("note_item_state RLS posture (local stack)", () => {
  let admin: SupabaseClient<Database>;
  let userA: TestUser;
  let userB: TestUser;

  async function createTestUser(label: string): Promise<TestUser> {
    const email = `nis-rls-${label}-${randomUUID()}@nova.test`;
    const password = `Pw-${randomUUID()}`;

    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (created.error) {
      throw new Error(`createUser(${label}): ${created.error.message}`);
    }

    const client = createClient<Database>(url ?? "", anonKey ?? "", noPersist);
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error)
      throw new Error(`signIn(${label}): ${signIn.error.message}`);

    const meeting = await client
      .from("meetings")
      .insert({ user_id: created.data.user.id, title: `state ${label}` })
      .select("id")
      .single();
    if (meeting.error)
      throw new Error(`meeting(${label}): ${meeting.error.message}`);

    return { id: created.data.user.id, client, meetingId: meeting.data.id };
  }

  /** Service-role seed — the ONLY sanctioned way one of these rows comes to exist. */
  async function seedState(user: TestUser, itemId: string): Promise<void> {
    const res = await admin.from("note_item_state").insert({
      meeting_id: user.meetingId,
      user_id: user.id,
      item_id: itemId,
      item_text: "Send the scope comparison.",
      completed_at: new Date().toISOString(),
    });
    if (res.error) throw new Error(`seed: ${res.error.message}`);
  }

  beforeAll(async () => {
    if (!url || !serviceRoleKey || !anonKey)
      throw new Error("stack env missing");
    admin = createClient<Database>(url, serviceRoleKey, noPersist);

    userA = await createTestUser("a");
    userB = await createTestUser("b");
    await seedState(userA, "a1");
    await seedState(userB, "a1");
  });

  afterAll(async () => {
    for (const user of [userA, userB]) {
      // Child-first, matching the FK order.
      await admin.from("note_item_state").delete().eq("user_id", user.id);
      await admin.from("meetings").delete().eq("user_id", user.id);
      await admin.auth.admin.deleteUser(user.id);
    }
  });

  it("[note-item-state-isolation] A reads its own row", async () => {
    const res = await userA.client
      .from("note_item_state")
      .select("item_id, item_text");

    expect(res.error).toBeNull();
    expect(res.data ?? []).toHaveLength(1);
    expect(res.data?.[0]?.item_id).toBe("a1");
  });

  it("[note-item-state-isolation] A cannot see B's row", async () => {
    // RLS FILTERS rather than errors: the tell is zero rows with a null error.
    const res = await userA.client
      .from("note_item_state")
      .select("item_id")
      .eq("meeting_id", userB.meetingId);

    expect(res.error).toBeNull();
    expect(res.data ?? []).toHaveLength(0);
  });

  it("[note-item-state-isolation] B cannot read its OWN soft-deleted row", async () => {
    // The lesson from 20260728120000: live_notes' policy checked ownership alone,
    // so a stamped deleted_at removed the row from every application read while
    // PostgREST still served it to the owner's JWT. This policy filters
    // deleted_at at the policy, which is the only layer a raw Data API call
    // cannot route around.
    const stamped = await admin
      .from("note_item_state")
      .update({ deleted_at: new Date().toISOString() })
      .eq("meeting_id", userB.meetingId);
    expect(stamped.error).toBeNull();

    try {
      const res = await userB.client.from("note_item_state").select("item_id");
      expect(res.error).toBeNull();
      expect(res.data ?? []).toHaveLength(0);
    } finally {
      await admin
        .from("note_item_state")
        .update({ deleted_at: null })
        .eq("meeting_id", userB.meetingId);
    }
  });

  it("[note-item-state-posture] authenticated cannot INSERT, even for itself", async () => {
    const fresh = await userA.client
      .from("meetings")
      .insert({ user_id: userA.id, title: "forge target" })
      .select("id")
      .single();
    if (fresh.error) throw new Error(`meeting: ${fresh.error.message}`);

    const res = await userA.client.from("note_item_state").insert({
      meeting_id: fresh.data.id,
      user_id: userA.id,
      item_id: "a9",
      item_text: "Forged.",
      completed_at: new Date().toISOString(),
    });

    expect(res.error).not.toBeNull();

    const check = await admin
      .from("note_item_state")
      .select("item_id")
      .eq("meeting_id", fresh.data.id);
    expect(check.data ?? []).toHaveLength(0);
  });

  it("[note-item-state-posture] authenticated cannot UPDATE its own row", async () => {
    // The attack this blocks is not privilege escalation — it is a client
    // rewriting `item_text` to whatever the notes currently say, which would
    // defeat the staleness guard and pin a checkmark on forever.
    const res = await userA.client
      .from("note_item_state")
      .update({ item_text: "Anything I like." })
      .eq("meeting_id", userA.meetingId);

    expect(res.error).not.toBeNull();

    const check = await admin
      .from("note_item_state")
      .select("item_text")
      .eq("meeting_id", userA.meetingId)
      .single();
    expect(check.data?.item_text).toBe("Send the scope comparison.");
  });

  it("[note-item-state-posture] authenticated cannot DELETE its own row", async () => {
    const res = await userA.client
      .from("note_item_state")
      .delete()
      .eq("meeting_id", userA.meetingId);

    expect(res.error).not.toBeNull();

    const check = await admin
      .from("note_item_state")
      .select("item_id")
      .eq("meeting_id", userA.meetingId);
    expect(check.data ?? []).toHaveLength(1);
  });

  it("[note-item-state-posture] anon is locked out entirely", async () => {
    const anon = createClient<Database>(url ?? "", anonKey ?? "", noPersist);
    const res = await anon.from("note_item_state").select("item_id");

    expect(res.data ?? []).toHaveLength(0);
  });

  it("[note-item-state-posture] service_role writes and reads back (positive control)", async () => {
    // A grant that is TOO tight fails here — the server must still be able to work.
    const res = await admin
      .from("note_item_state")
      .update({ completed_at: null })
      .eq("meeting_id", userA.meetingId)
      .select("completed_at")
      .single();

    expect(res.error).toBeNull();
    expect(res.data?.completed_at).toBeNull();

    await admin
      .from("note_item_state")
      .update({ completed_at: new Date().toISOString() })
      .eq("meeting_id", userA.meetingId);
  });
});
