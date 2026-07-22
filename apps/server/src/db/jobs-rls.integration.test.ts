import { randomUUID } from "node:crypto";

import {
  createClient,
  type PostgrestSingleResponse,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `jobs` RLS-posture proof — the permanent CI gate for "the durable queue is
 * service-role-only: an authenticated user's JWT gets nothing, service_role has
 * full access". Sibling to rag-isolation.integration.test.ts (same two-real-users,
 * JWT-direct-against-PostgREST approach, so the guarantee under test is Postgres
 * RLS itself, not application code). `jobs` ships RLS ENABLED with ZERO policies and
 * grants to service_role only — the `deletion_requests` posture.
 *
 * Covers (all against the LIVE stack):
 *   - service_role inserts a generate_notes job on A's meeting + reads it back
 *     (defaults: status='queued', attempts 0, max_attempts 5).
 *   - A's JWT select on jobs → zero rows (locked out; no grant, no policy).
 *   - A's JWT insert on jobs → denied; service-role confirms nothing was written.
 *   - service-role insert of a meeting with a bogus notes_status → rejected by the
 *     named CHECK (`meetings_notes_status_check`).
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SUPABASE_ANON_KEY (all three
 * from `supabase status -o env`). Unless ALL are present the suite skips, so the
 * default `npm run test` stays green without a running stack.
 */

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const hasStack = Boolean(url && serviceRoleKey && anonKey);

// Minimal hand-written `Database` type (mirrors the sibling suites — kept local so
// `.from(...)` stays type-safe under strict-type-checked eslint). These MUST be
// `type` aliases, not `interface`s: supabase-js's `GenericTable` constrains `Row` to
// `Record<string, unknown>`, which interfaces do not satisfy.
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
type JobRow = {
  id: string;
  kind: string;
  meeting_id: string;
  user_id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  run_at: string;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  raw_output: string | null;
  usage: unknown;
  created_at: string;
  updated_at: string;
};
type Database = {
  public: {
    Tables: {
      meetings: {
        Row: MeetingRow;
        // Insert admits notes_status so the CHECK-rejection case can target it.
        Insert: { user_id: string; title: string; notes_status?: string };
        Update: Partial<MeetingRow>;
        Relationships: [];
      };
      jobs: {
        Row: JobRow;
        Insert: { kind: string; meeting_id: string; user_id: string };
        Update: Partial<JobRow>;
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

describe.skipIf(!hasStack)("jobs RLS posture (local stack)", () => {
  let apiUrl: string;
  let publishableKey: string;
  let admin: Db;
  let userA: TestUser;
  const createdUserIds: string[] = [];

  // Populated by the service-role test, then read by the isolation tests.
  let aMeetingId: string;
  let aJobId: string;

  /** Admin-create a confirmed user, then sign in a per-user (JWT) client for them. */
  async function createTestUser(label: string): Promise<TestUser> {
    const suffix = randomUUID();
    const email = `jobs-rls-${label}-${suffix}@nova.test`;
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

  /** Service-role teardown: jobs FK meetings (NO ACTION), so delete jobs first. */
  async function purgeUser(userId: string): Promise<void> {
    await admin.from("jobs").delete().eq("user_id", userId);
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

    // A owns a live meeting (the job's parent).
    const meeting = unwrap(
      await userA.client
        .from("meetings")
        .insert({ user_id: userA.id, title: "A meeting for jobs posture test" })
        .select()
        .single(),
      "A insert meeting",
    );
    aMeetingId = meeting.id;
  });

  afterAll(async () => {
    for (const id of createdUserIds) {
      await purgeUser(id);
    }
  });

  it("[jobs-service-role] service_role inserts a job and reads it back with defaults", async () => {
    const job = unwrap(
      await admin
        .from("jobs")
        .insert({
          kind: "generate_notes",
          meeting_id: aMeetingId,
          user_id: userA.id,
        })
        .select()
        .single(),
      "service-role insert job",
    );
    aJobId = job.id;

    expect(job.kind).toBe("generate_notes");
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(0);
    expect(job.max_attempts).toBe(5);
    expect(job.meeting_id).toBe(aMeetingId);
    expect(job.user_id).toBe(userA.id);

    // And service_role can read it back.
    const readBack = unwrap(
      await admin.from("jobs").select().eq("id", job.id),
      "service-role read job",
    );
    expect(readBack).toHaveLength(1);
  });

  it("[jobs-posture] A's JWT sees zero rows on jobs (locked out)", async () => {
    const res = await userA.client.from("jobs").select().eq("id", aJobId);
    // No grant + no policy → PostgREST denies or returns nothing; either way the
    // authenticated caller can never see the queue row.
    expect(res.data ?? []).toHaveLength(0);
  });

  it("[jobs-posture] A's JWT cannot INSERT a job (denied; nothing written)", async () => {
    const res = await userA.client
      .from("jobs")
      .insert({
        kind: "generate_notes",
        meeting_id: aMeetingId,
        user_id: userA.id,
      })
      .select();

    expect(res.error).not.toBeNull();
    expect(res.data ?? []).toHaveLength(0);

    // Service role confirms only the one service-role-inserted job exists on A's meeting.
    const jobs = unwrap(
      await admin.from("jobs").select().eq("meeting_id", aMeetingId),
      "service-role read jobs",
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe(aJobId);
  });

  it("[jobs-check] a meeting with a bogus notes_status is rejected by the CHECK", async () => {
    const res = await admin
      .from("meetings")
      .insert({
        user_id: userA.id,
        title: "bogus notes_status",
        notes_status: "not_a_real_status",
      })
      .select();

    expect(res.error).not.toBeNull();
    // 23514 = check_violation; the message names the constraint.
    expect(res.error?.message ?? "").toContain("meetings_notes_status_check");
    expect(res.data ?? []).toHaveLength(0);
  });
});
