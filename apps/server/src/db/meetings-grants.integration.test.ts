import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Meetings grant posture proof — the sibling of `profiles-grants` for the SECOND
 * table that shipped a blanket `grant update ... to authenticated`.
 * `20260723100000` closed the hole on `profiles` (a user JWT could self-set
 * plan='pro' / role='admin') but left `meetings` wide open, where the same shape
 * is worse than an integrity bug — it is a VENDOR-SPEND vector:
 *
 *   - `indexed_at` drives the RAG completion sweeper (it indexes meetings whose
 *     `ended_at` is set and `indexed_at` is null). A client that clears it
 *     re-indexes the same call on every sweep → unbounded Voyage embedding spend.
 *   - `ended_at` is what makes a meeting eligible for the notes sweep backstop.
 *     A client that stamps it on N meetings enqueues N generate_notes jobs → LLM
 *     spend, from a plain PostgREST write.
 *   - `notes` / `notes_status` / `notes_generated_at` / `follow_up` are
 *     server-authored: a client could forge "completed" notes it never paid for.
 *
 * These tests hit PostgREST DIRECTLY with a real user's JWT, so what is under
 * test is the Postgres GRANT itself, not application code. 42501 is
 * `insufficient_privilege` — the column-scoped grant rejecting the write.
 *
 * Requires the full stack env; skips without it (isolation-suite convention).
 */

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const hasStack = Boolean(url && serviceRoleKey && anonKey);

// Minimal `Database` type (MUST be `type` aliases — the GenericTable constraint).
type MeetingRow = {
  id: string;
  user_id: string;
  title: string;
  started_at: string | null;
  ended_at: string | null;
  indexed_at: string | null;
  notes: unknown;
  notes_status: string;
  notes_generated_at: string | null;
  follow_up: unknown;
  created_at: string;
  deleted_at: string | null;
};
type Database = {
  public: {
    Tables: {
      meetings: {
        Row: MeetingRow;
        Insert: Partial<MeetingRow> & { user_id: string; title: string };
        Update: Partial<MeetingRow>;
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

/** `insufficient_privilege` — a column-scoped GRANT refusing the write. */
const PERMISSION_DENIED = "42501";

describe.skipIf(!hasStack)("meetings grant posture (local stack)", () => {
  let admin: SupabaseClient<Database>;
  let userClient: SupabaseClient<Database>;
  let userId: string;
  let meetingId: string;

  beforeAll(async () => {
    if (!url || !serviceRoleKey || !anonKey) {
      throw new Error("stack env missing");
    }
    admin = createClient<Database>(url, serviceRoleKey, noPersist);

    const email = `mgrants-${randomUUID()}@nova.test`;
    const password = `Pw-${randomUUID()}`;
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (created.error) throw new Error(`createUser: ${created.error.message}`);
    userId = created.data.user.id;

    userClient = createClient<Database>(url, anonKey, noPersist);
    const signIn = await userClient.auth.signInWithPassword({
      email,
      password,
    });
    if (signIn.error) throw new Error(`signIn: ${signIn.error.message}`);

    const inserted = await userClient
      .from("meetings")
      .insert({ user_id: userId, title: "Grant posture call" })
      .select("id")
      .single();
    if (inserted.error) throw new Error(`insert: ${inserted.error.message}`);
    meetingId = inserted.data.id;
  });

  afterAll(async () => {
    await admin.from("meetings").delete().eq("user_id", userId);
    await admin.auth.admin.deleteUser(userId);
  });

  it("[grants] the mobile insert path still works (user_id + title)", () => {
    // Proven by beforeAll: `use-live-session` creates the meeting this way, and
    // the whole suite depends on that row existing.
    expect(meetingId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("[grants] UPDATE title on the user's OWN row still works", async () => {
    const res = await userClient
      .from("meetings")
      .update({ title: "Renamed by owner" })
      .eq("id", meetingId)
      .select("title")
      .single();

    expect(res.error).toBeNull();
    expect(res.data?.title).toBe("Renamed by owner");
  });

  it("[grants] UPDATE deleted_at still works (the soft-delete law)", async () => {
    const stamp = new Date().toISOString();
    const res = await userClient
      .from("meetings")
      .update({ deleted_at: stamp })
      .eq("id", meetingId)
      .select("deleted_at")
      .single();

    expect(res.error).toBeNull();
    expect(res.data?.deleted_at).not.toBeNull();

    // Undo so the later cases operate on a live row.
    await admin
      .from("meetings")
      .update({ deleted_at: null })
      .eq("id", meetingId);
  });

  it("[grants] UPDATE indexed_at is permission denied (the re-index spend vector)", async () => {
    const res = await userClient
      .from("meetings")
      .update({ indexed_at: null })
      .eq("id", meetingId);

    expect(res.error).not.toBeNull();
    expect(res.error?.code).toBe(PERMISSION_DENIED);
  });

  it("[grants] UPDATE ended_at is permission denied (the notes-enqueue spend vector)", async () => {
    const res = await userClient
      .from("meetings")
      .update({ ended_at: new Date().toISOString() })
      .eq("id", meetingId);

    expect(res.error).not.toBeNull();
    expect(res.error?.code).toBe(PERMISSION_DENIED);
  });

  it("[grants] UPDATE notes_status is permission denied (no forged 'completed')", async () => {
    const res = await userClient
      .from("meetings")
      .update({ notes_status: "completed" })
      .eq("id", meetingId);

    expect(res.error).not.toBeNull();
    expect(res.error?.code).toBe(PERMISSION_DENIED);

    const check = await admin
      .from("meetings")
      .select("notes_status")
      .eq("id", meetingId)
      .single();
    expect(check.data?.notes_status).toBe("none");
  });

  it("[grants] UPDATE notes is permission denied (server-authored column)", async () => {
    const res = await userClient
      .from("meetings")
      .update({ notes: { version: 2, title: "forged" } })
      .eq("id", meetingId);

    expect(res.error).not.toBeNull();
    expect(res.error?.code).toBe(PERMISSION_DENIED);
  });

  it("[grants] INSERT cannot smuggle server-authored columns either", async () => {
    const res = await userClient.from("meetings").insert({
      user_id: userId,
      title: "smuggled",
      notes_status: "completed",
      indexed_at: new Date().toISOString(),
    });

    expect(res.error).not.toBeNull();
    expect(res.error?.code).toBe(PERMISSION_DENIED);
  });

  it("[grants] service_role still writes the notes columns (the pipeline path)", async () => {
    const res = await admin
      .from("meetings")
      .update({
        notes_status: "completed",
        notes_generated_at: new Date().toISOString(),
      })
      .eq("id", meetingId)
      .select("notes_status")
      .single();

    expect(res.error).toBeNull();
    expect(res.data?.notes_status).toBe("completed");
  });
});
