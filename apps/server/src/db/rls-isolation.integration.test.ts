import { randomUUID } from "node:crypto";

import {
  createClient,
  type PostgrestSingleResponse,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * RLS tenant-isolation A/B proof — the permanent CI gate for "User A can never
 * read/write User B's rows". These tests hit Supabase/PostgREST DIRECTLY with two
 * real users' JWTs (NOT through the Fastify server) so the guarantee under test is
 * Postgres row-level security itself, not application code.
 *
 * Importing `@supabase/supabase-js` here is intentional and allowed: this file is
 * the DB-boundary test, so exercising the vendor SDK directly (per-user clients +
 * admin API) IS the point. Production code keeps the SDK behind an adapter.
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SUPABASE_ANON_KEY (all three
 * from `supabase status -o env`). Unless ALL are present the suite skips, so the
 * default `npm run test` stays green without a running stack.
 */

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const hasStack = Boolean(url && serviceRoleKey && anonKey);

// Minimal hand-written `Database` type for the four Phase-1 tables. Mirrors the
// migrations in supabase/migrations/2026*. Kept local to this test (the server's
// schema.ts only types `_smoke`) so `.from(...)` calls stay type-safe under the
// repo's strict-type-checked eslint (no `any` widening).
//
// These MUST be `type` aliases, not `interface`s: supabase-js's `GenericTable`
// constrains `Row` to `Record<string, unknown>`, which object-literal type aliases
// satisfy implicitly but interfaces do not — an interface here silently degrades
// every query result to `never`.
type ProfileRow = {
  id: string;
  display_name: string | null;
  created_at: string;
  deleted_at: string | null;
};
type MeetingRow = {
  id: string;
  user_id: string;
  title: string;
  started_at: string | null;
  created_at: string;
  deleted_at: string | null;
};
type TranscriptRow = {
  id: string;
  meeting_id: string;
  user_id: string;
  content: string;
  created_at: string;
  deleted_at: string | null;
};
type ContextDocRow = {
  id: string;
  user_id: string;
  title: string;
  content: string;
  created_at: string;
  deleted_at: string | null;
};
type Database = {
  public: {
    Tables: {
      profiles: {
        Row: ProfileRow;
        Insert: { id: string; display_name?: string | null };
        Update: Partial<ProfileRow>;
        Relationships: [];
      };
      meetings: {
        Row: MeetingRow;
        Insert: { user_id: string; title: string };
        Update: Partial<MeetingRow>;
        Relationships: [];
      };
      transcripts: {
        Row: TranscriptRow;
        Insert: { meeting_id: string; user_id: string; content: string };
        Update: Partial<TranscriptRow>;
        Relationships: [];
      };
      context_docs: {
        Row: ContextDocRow;
        Insert: { user_id: string; title: string; content: string };
        Update: Partial<ContextDocRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

type Db = SupabaseClient<Database>;

interface TestUser {
  id: string;
  email: string;
  password: string;
  /** A per-user client whose requests carry that user's JWT (role: authenticated). */
  client: Db;
}

/** Throw on a PostgREST error so `.single()` callers fail loudly at the boundary. */
function unwrap<T>(res: PostgrestSingleResponse<T>, ctx: string): T {
  if (res.error) throw new Error(`${ctx}: ${res.error.message}`);
  return res.data;
}

const noPersist = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

describe.skipIf(!hasStack)("RLS tenant isolation (local stack)", () => {
  let apiUrl: string;
  let publishableKey: string;
  let admin: Db;
  let userA: TestUser;
  let userB: TestUser;
  // Ids of users actually created, so teardown purges exactly what setup made
  // (even if beforeAll fails partway).
  const createdUserIds: string[] = [];

  /** Admin-create a confirmed user, then sign in a per-user (JWT) client for them. */
  async function createTestUser(label: string): Promise<TestUser> {
    const suffix = randomUUID();
    const email = `rls-${label}-${suffix}@nova.test`;
    const password = `Pw-${randomUUID()}`;

    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (created.error) {
      throw new Error(`createUser(${label}) failed: ${created.error.message}`);
    }

    const client = createClient<Database>(apiUrl, publishableKey, noPersist);
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) {
      throw new Error(`signIn(${label}) failed: ${signIn.error.message}`);
    }

    return { id: created.data.user.id, email, password, client };
  }

  /**
   * Service-role teardown. Task-1 FKs RESTRICT children, so delete rows child-first
   * (transcripts -> meetings, plus context_docs) BEFORE deleting the auth user,
   * whose removal cascades the profile away (profiles.id -> auth.users on delete).
   */
  async function purgeUser(userId: string): Promise<void> {
    await admin.from("transcripts").delete().eq("user_id", userId);
    await admin.from("meetings").delete().eq("user_id", userId);
    await admin.from("context_docs").delete().eq("user_id", userId);
    await admin.auth.admin.deleteUser(userId);
  }

  beforeAll(async () => {
    // skipIf guarantees these at runtime; narrow for the type checker.
    if (!url || !serviceRoleKey || !anonKey) {
      throw new Error("Supabase stack env vars missing");
    }
    apiUrl = url;
    publishableKey = anonKey;
    admin = createClient<Database>(url, serviceRoleKey, noPersist);

    userA = await createTestUser("a");
    createdUserIds.push(userA.id);
    userB = await createTestUser("b");
    createdUserIds.push(userB.id);
  });

  afterAll(async () => {
    for (const id of createdUserIds) {
      await purgeUser(id);
    }
  });

  it("[signup-profile] trigger provisions A's profile; A sees own, not B's", async () => {
    const own = await userA.client
      .from("profiles")
      .select()
      .eq("id", userA.id);
    expect(own.error).toBeNull();
    expect(own.data ?? []).toHaveLength(1);
    expect(own.data?.[0]?.id).toBe(userA.id);

    // B's profile exists (B was created too) but is invisible to A via RLS.
    const other = await userA.client
      .from("profiles")
      .select()
      .eq("id", userB.id);
    expect(other.error).toBeNull();
    expect(other.data ?? []).toHaveLength(0);
  });

  it("[isolation-select] B cannot SELECT A's meeting / transcript / context_doc", async () => {
    const meeting = unwrap(
      await userA.client
        .from("meetings")
        .insert({ user_id: userA.id, title: "A private meeting" })
        .select()
        .single(),
      "A insert meeting",
    );
    unwrap(
      await userA.client
        .from("transcripts")
        .insert({
          meeting_id: meeting.id,
          user_id: userA.id,
          content: "A private transcript",
        })
        .select()
        .single(),
      "A insert transcript",
    );
    unwrap(
      await userA.client
        .from("context_docs")
        .insert({ user_id: userA.id, title: "A doc", content: "A private doc" })
        .select()
        .single(),
      "A insert context_doc",
    );

    const bMeetings = await userB.client.from("meetings").select();
    expect(bMeetings.error).toBeNull();
    expect(bMeetings.data ?? []).toHaveLength(0);

    const bTranscripts = await userB.client.from("transcripts").select();
    expect(bTranscripts.error).toBeNull();
    expect(bTranscripts.data ?? []).toHaveLength(0);

    const bDocs = await userB.client.from("context_docs").select();
    expect(bDocs.error).toBeNull();
    expect(bDocs.data ?? []).toHaveLength(0);
  });

  it("[isolation-insert-spoof] B cannot INSERT a meeting owned by A", async () => {
    const res = await userB.client
      .from("meetings")
      .insert({ user_id: userA.id, title: "spoofed" })
      .select();

    // with-check violation: PostgREST returns an RLS error, no row written.
    expect(res.error).not.toBeNull();
    expect(res.data ?? []).toHaveLength(0);
  });

  it("[isolation-update] B cannot UPDATE A's meeting (0 rows, no leak)", async () => {
    const meeting = unwrap(
      await userA.client
        .from("meetings")
        .insert({ user_id: userA.id, title: "A owns this" })
        .select()
        .single(),
      "A insert meeting",
    );

    const attempt = await userB.client
      .from("meetings")
      .update({ title: "hacked by B" })
      .eq("id", meeting.id)
      .select();
    // RLS filters the target row out of B's scope: no error leak, nothing updated.
    expect(attempt.error).toBeNull();
    expect(attempt.data ?? []).toHaveLength(0);

    // A's row is untouched.
    const after = unwrap(
      await userA.client
        .from("meetings")
        .select()
        .eq("id", meeting.id)
        .single(),
      "A re-read meeting",
    );
    expect(after.title).toBe("A owns this");
  });

  it("[no-hard-delete] A cannot hard-DELETE own meeting; row survives", async () => {
    const meeting = unwrap(
      await userA.client
        .from("meetings")
        .insert({ user_id: userA.id, title: "keep me" })
        .select()
        .single(),
      "A insert meeting",
    );

    // No DELETE policy and no DELETE grant to `authenticated`: the delete removes
    // nothing (whether rejected outright or scoped to zero rows).
    const del = await userA.client
      .from("meetings")
      .delete()
      .eq("id", meeting.id)
      .select();
    expect(del.data ?? []).toHaveLength(0);

    const survivor = unwrap(
      await userA.client
        .from("meetings")
        .select()
        .eq("id", meeting.id)
        .single(),
      "A re-read meeting",
    );
    expect(survivor.id).toBe(meeting.id);
  });

  it("[soft-delete] A soft-deletes own meeting; hidden from A, tombstone for service role", async () => {
    const meeting = unwrap(
      await userA.client
        .from("meetings")
        .insert({ user_id: userA.id, title: "to be soft-deleted" })
        .select()
        .single(),
      "A insert meeting",
    );

    // Soft delete IS an UPDATE (allowed by the ownership update policy).
    const soft = await userA.client
      .from("meetings")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", meeting.id)
      .select();
    expect(soft.error).toBeNull();
    expect(soft.data ?? []).toHaveLength(1);

    // A's conventional live read (deleted_at is null) no longer sees it.
    const live = await userA.client
      .from("meetings")
      .select()
      .eq("id", meeting.id)
      .is("deleted_at", null);
    expect(live.error).toBeNull();
    expect(live.data ?? []).toHaveLength(0);

    // Service role (bypasses RLS) still sees the tombstone with deleted_at set.
    const tomb = unwrap(
      await admin.from("meetings").select().eq("id", meeting.id).single(),
      "service-role re-read meeting",
    );
    expect(tomb.deleted_at).not.toBeNull();
  });

  it("[anon-locked-out] a bare anon client reads no data from any table", async () => {
    const anon = createClient<Database>(apiUrl, publishableKey, noPersist);

    const profiles = await anon.from("profiles").select();
    expect(profiles.data ?? []).toHaveLength(0);

    const meetings = await anon.from("meetings").select();
    expect(meetings.data ?? []).toHaveLength(0);

    const transcripts = await anon.from("transcripts").select();
    expect(transcripts.data ?? []).toHaveLength(0);

    const contextDocs = await anon.from("context_docs").select();
    expect(contextDocs.data ?? []).toHaveLength(0);
  });
});
