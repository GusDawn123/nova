import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFallbackNotes } from "@nova/shared";

/**
 * `public.live_notes` RLS + grant posture proof (Phase 8,
 * docs/DESIGN/live-notes.md §7; RULES §4.9 requires this in the same PR as the
 * policy). The table is SERVER-AUTHORED: `authenticated` may SELECT its own rows
 * and nothing else — no insert/update policy, no insert/update grant.
 *
 * That posture is the whole point. A client that could write `live_notes` could
 * forge the running record the post-call pipeline reconciles its ids against, and
 * could plant content into a surface the user reads as a transcript of their own
 * call. `meetings` shipped the opposite default and needed `20260725120000` to walk
 * it back; this table never opens the hole.
 *
 * These tests hit PostgREST DIRECTLY with a real user's JWT, so what is under test
 * is the Postgres policy/grant itself, not application code.
 *
 * Requires the full stack env; skips without it (isolation-suite convention).
 */

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const hasStack = Boolean(url && serviceRoleKey && anonKey);

// Minimal `Database` type (MUST be `type` aliases — the GenericTable constraint:
// supabase-js constrains `Row` to Record<string, unknown>, which object-literal
// type aliases satisfy implicitly but interfaces do not; an interface here
// silently degrades every query result to `never`).
type LiveNotesRowShape = {
  meeting_id: string;
  user_id: string;
  notes: unknown;
  rev: number;
  updated_at: string;
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
      live_notes: {
        Row: LiveNotesRowShape;
        Insert: Partial<LiveNotesRowShape> & {
          meeting_id: string;
          user_id: string;
          notes: unknown;
        };
        Update: Partial<LiveNotesRowShape>;
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

describe.skipIf(!hasStack)("live_notes RLS posture (local stack)", () => {
  let admin: SupabaseClient<Database>;
  let userA: TestUser;
  let userB: TestUser;

  /** Mint a real user JWT (admin-create then password sign-in) + seed a meeting. */
  async function createTestUser(label: string): Promise<TestUser> {
    const email = `ln-rls-${label}-${randomUUID()}@nova.test`;
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
      .insert({ user_id: created.data.user.id, title: `live notes ${label}` })
      .select("id")
      .single();
    if (meeting.error)
      throw new Error(`meeting(${label}): ${meeting.error.message}`);

    return { id: created.data.user.id, client, meetingId: meeting.data.id };
  }

  /** Service-role seed — the ONLY sanctioned way a live_notes row comes to exist. */
  async function seedLiveNotes(user: TestUser, rev: number): Promise<void> {
    const res = await admin.from("live_notes").insert({
      meeting_id: user.meetingId,
      user_id: user.id,
      notes: { ...buildFallbackNotes("Seeded call"), source: "live" },
      rev,
    });
    if (res.error) throw new Error(`seed: ${res.error.message}`);
  }

  beforeAll(async () => {
    if (!url || !serviceRoleKey || !anonKey)
      throw new Error("stack env missing");
    admin = createClient<Database>(url, serviceRoleKey, noPersist);

    userA = await createTestUser("a");
    userB = await createTestUser("b");
    await seedLiveNotes(userA, 3);
    await seedLiveNotes(userB, 5);
  });

  afterAll(async () => {
    for (const user of [userA, userB]) {
      // Child-first, matching the FK order.
      await admin.from("live_notes").delete().eq("user_id", user.id);
      await admin.from("meetings").delete().eq("user_id", user.id);
      await admin.auth.admin.deleteUser(user.id);
    }
  });

  it("[live-notes-isolation] A reads its own row", async () => {
    const res = await userA.client.from("live_notes").select("meeting_id, rev");
    expect(res.error).toBeNull();
    expect(res.data ?? []).toHaveLength(1);
    expect(res.data?.[0]?.rev).toBe(3);
  });

  it("[live-notes-isolation] A cannot see B's row", async () => {
    // RLS FILTERS rather than errors: the tell is zero rows with a null error.
    const res = await userA.client
      .from("live_notes")
      .select("meeting_id, rev")
      .eq("meeting_id", userB.meetingId);

    expect(res.error).toBeNull();
    expect(res.data ?? []).toHaveLength(0);
  });

  it("[live-notes-isolation] A cannot read its OWN soft-deleted row", async () => {
    // RULES §3: soft delete is the delete. The column comment on live_notes says
    // reads filter `deleted_at is null`, but the SELECT policy only checked
    // ownership — so stamping deleted_at removed the row from every application
    // read while PostgREST still served it to the owner's JWT. "Deleted" has to
    // mean deleted at the policy, which is the only layer a raw Data API call
    // cannot route around.
    const stamped = await admin
      .from("live_notes")
      .update({ deleted_at: new Date().toISOString() })
      .eq("meeting_id", userB.meetingId);
    expect(stamped.error).toBeNull();

    try {
      const res = await userB.client
        .from("live_notes")
        .select("meeting_id, rev");
      expect(res.error).toBeNull();
      expect(res.data ?? []).toHaveLength(0);
    } finally {
      // Restore so later cases still see B's row (order independence).
      await admin
        .from("live_notes")
        .update({ deleted_at: null })
        .eq("meeting_id", userB.meetingId);
    }
  });

  it("[live-notes-posture] authenticated cannot INSERT, even for itself", async () => {
    const fresh = await userA.client
      .from("meetings")
      .insert({ user_id: userA.id, title: "forge target" })
      .select("id")
      .single();
    if (fresh.error) throw new Error(`meeting: ${fresh.error.message}`);

    const res = await userA.client.from("live_notes").insert({
      meeting_id: fresh.data.id,
      user_id: userA.id,
      notes: { ...buildFallbackNotes("Forged"), source: "live" },
      rev: 99,
    });

    expect(res.error).not.toBeNull();

    // Service role confirms nothing landed.
    const check = await admin
      .from("live_notes")
      .select("meeting_id")
      .eq("meeting_id", fresh.data.id);
    expect(check.data ?? []).toHaveLength(0);
  });

  it("[live-notes-posture] authenticated cannot UPDATE its own row", async () => {
    const res = await userA.client
      .from("live_notes")
      .update({ rev: 999 })
      .eq("meeting_id", userA.meetingId);

    expect(res.error).not.toBeNull();

    const check = await admin
      .from("live_notes")
      .select("rev")
      .eq("meeting_id", userA.meetingId)
      .single();
    expect(check.data?.rev).toBe(3);
  });

  it("[live-notes-posture] authenticated cannot DELETE its own row", async () => {
    // No delete grant and no delete policy — removal is the purge job's job
    // (RULES §3 soft-delete law).
    const res = await userA.client
      .from("live_notes")
      .delete()
      .eq("meeting_id", userA.meetingId);

    expect(res.error).not.toBeNull();

    const check = await admin
      .from("live_notes")
      .select("meeting_id")
      .eq("meeting_id", userA.meetingId);
    expect(check.data ?? []).toHaveLength(1);
  });

  it("[live-notes-posture] anon is locked out entirely", async () => {
    const anon = createClient<Database>(url ?? "", anonKey ?? "", noPersist);
    const res = await anon.from("live_notes").select("meeting_id");

    // No policy grants anon anything: either an error or an empty set, never data.
    expect(res.data ?? []).toHaveLength(0);
  });

  it("[live-notes-posture] service_role writes and reads back (the positive control)", async () => {
    // A grant that is TOO tight fails here — the server must still be able to work.
    const res = await admin
      .from("live_notes")
      .update({ rev: 4 })
      .eq("meeting_id", userA.meetingId)
      .select("rev")
      .single();

    expect(res.error).toBeNull();
    expect(res.data?.rev).toBe(4);

    // Restore so test order cannot leak into the isolation cases above.
    await admin
      .from("live_notes")
      .update({ rev: 3 })
      .eq("meeting_id", userA.meetingId);
  });
});
