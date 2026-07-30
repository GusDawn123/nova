import { randomUUID } from "node:crypto";

import {
  createClient,
  type PostgrestSingleResponse,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Transcript parentage A/B proof — the permanent CI gate for "a transcript can only
 * be written against a live meeting the writer owns". Sibling to
 * rls-isolation.integration.test.ts (kept separate to stay under the ~400-line file
 * cap): same two-real-users, JWT-direct-against-PostgREST approach, so the guarantee
 * under test is the Postgres RLS with-check itself, not application code.
 *
 * The hole this closes (Phase 1 review, proven live): the transcript INSERT/UPDATE
 * with-check validated only `user_id = auth.uid()`, NOT that the referenced
 * `meeting_id` belongs to the writer and is still live — so User B could insert a
 * transcript they own against User A's meeting, corrupting parentage and wedging A's
 * account purge (the foreign child blocks A's `meetings` delete).
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SUPABASE_ANON_KEY (all three
 * from `supabase status -o env`). Unless ALL are present the suite skips, so the
 * default `npm run test` stays green without a running stack.
 */

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const hasStack = Boolean(url && serviceRoleKey && anonKey);

// Minimal hand-written `Database` type (mirrors rls-isolation.integration.test.ts —
// kept local so `.from(...)` stays type-safe under strict-type-checked eslint). These
// MUST be `type` aliases, not `interface`s: supabase-js's `GenericTable` constrains
// `Row` to `Record<string, unknown>`, which interfaces do not satisfy (results would
// silently degrade to `never`).
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
type Database = {
  public: {
    Tables: {
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

describe.skipIf(!hasStack)("transcript parentage (local stack)", () => {
  let apiUrl: string;
  let publishableKey: string;
  let admin: Db;
  let userA: TestUser;
  let userB: TestUser;
  const createdUserIds: string[] = [];

  /** Admin-create a confirmed user, then sign in a per-user (JWT) client for them. */
  async function createTestUser(label: string): Promise<TestUser> {
    const suffix = randomUUID();
    const email = `parentage-${label}-${suffix}@nova.test`;
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

  /** Service-role teardown: FKs RESTRICT children, so delete child-first. */
  async function purgeUser(userId: string): Promise<void> {
    await admin.from("transcripts").delete().eq("user_id", userId);
    await admin.from("meetings").delete().eq("user_id", userId);
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

  it("[parentage-spoof] B cannot INSERT a transcript against A's meeting", async () => {
    const aMeeting = unwrap(
      await userA.client
        .from("meetings")
        .insert({ user_id: userA.id, title: "A's meeting" })
        .select()
        .single(),
      "A insert meeting",
    );

    // B owns the transcript row (user_id = self, so the old flat check passed) but
    // points meeting_id at A's meeting. The parentage with-check must reject it.
    const res = await userB.client
      .from("transcripts")
      .insert({
        meeting_id: aMeeting.id,
        user_id: userB.id,
        content: "B spoofing onto A's meeting",
      })
      .select();

    expect(res.error).not.toBeNull();
    expect(res.data ?? []).toHaveLength(0);

    // Nothing was written against A's meeting (service role bypasses RLS to confirm).
    const children = unwrap(
      await admin.from("transcripts").select().eq("meeting_id", aMeeting.id),
      "service-role read transcripts",
    );
    expect(children).toHaveLength(0);
  });

  it("[parentage-happy] A CAN INSERT a transcript on A's own live meeting", async () => {
    const aMeeting = unwrap(
      await userA.client
        .from("meetings")
        .insert({ user_id: userA.id, title: "A live meeting" })
        .select()
        .single(),
      "A insert meeting",
    );

    const row = unwrap(
      await userA.client
        .from("transcripts")
        .insert({
          meeting_id: aMeeting.id,
          user_id: userA.id,
          content: "A's own transcript",
        })
        .select()
        .single(),
      "A insert own transcript",
    );

    expect(row.meeting_id).toBe(aMeeting.id);
    expect(row.user_id).toBe(userA.id);
  });

  it("[parentage-soft-deleted] A cannot INSERT a transcript on A's soft-deleted meeting", async () => {
    const aMeeting = unwrap(
      await userA.client
        .from("meetings")
        .insert({ user_id: userA.id, title: "A meeting to soft-delete" })
        .select()
        .single(),
      "A insert meeting",
    );

    const soft = await userA.client
      .from("meetings")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", aMeeting.id)
      .select();
    expect(soft.error).toBeNull();
    expect(soft.data ?? []).toHaveLength(1);

    // Parent is a tombstone now — a transcript may not be written against it.
    const res = await userA.client
      .from("transcripts")
      .insert({
        meeting_id: aMeeting.id,
        user_id: userA.id,
        content: "transcript onto a dead meeting",
      })
      .select();

    expect(res.error).not.toBeNull();
    expect(res.data ?? []).toHaveLength(0);
  });
});
