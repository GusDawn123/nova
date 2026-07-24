import { randomUUID } from "node:crypto";

import {
  createClient,
  type PostgrestSingleResponse,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `usage_events` RLS-posture proof — the permanent CI gate for the metering ledger's
 * access rules (adr-0007 §1): users may READ their OWN usage rows (select_own) and
 * NOTHING of anyone else's; `authenticated` may NEVER write (no insert policy/grant);
 * service_role has full access. Sibling to jobs-rls / rls-isolation (same
 * two-real-users, JWT-direct-against-PostgREST approach, so the guarantee under test
 * is Postgres RLS itself, not application code).
 *
 * Covers (all against the LIVE stack):
 *   - service_role inserts usage rows for A and B and reads them back.
 *   - A's JWT SELECT sees ONLY A's rows (B's are invisible); B sees ZERO of A's.
 *   - A's JWT INSERT on usage_events → denied; service-role confirms nothing written.
 *   - service-role insert with a bogus `kind` → rejected by the CHECK constraint.
 *   - service-role insert of a profile-plan out of set → rejected by profiles_plan_check.
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
type UsageEventRow = {
  id: string;
  user_id: string;
  meeting_id: string | null;
  vendor: string;
  kind: string;
  amount: number;
  input_amount: number | null;
  output_amount: number | null;
  model: string | null;
  cost_estimate_usd: number;
  created_at: string;
};
type MeetingRow = {
  id: string;
  user_id: string;
  title: string;
};
type ProfileRow = {
  id: string;
  display_name: string | null;
  plan: string;
  created_at: string;
  deleted_at: string | null;
};
type Database = {
  public: {
    Tables: {
      usage_events: {
        Row: UsageEventRow;
        // Insert admits the columns the posture cases target (incl. a bogus kind).
        Insert: {
          user_id: string;
          vendor: string;
          kind: string;
          amount: number;
          meeting_id?: string | null;
          input_amount?: number | null;
          output_amount?: number | null;
          model?: string | null;
          cost_estimate_usd?: number;
        };
        Update: Partial<UsageEventRow>;
        Relationships: [];
      };
      meetings: {
        Row: MeetingRow;
        Insert: { user_id: string; title: string };
        Update: Partial<MeetingRow>;
        Relationships: [];
      };
      profiles: {
        Row: ProfileRow;
        // Insert admits `plan` so the CHECK-rejection case can target it.
        Insert: { id: string; display_name?: string | null; plan?: string };
        Update: Partial<ProfileRow>;
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

describe.skipIf(!hasStack)("usage_events RLS posture (local stack)", () => {
  let apiUrl: string;
  let publishableKey: string;
  let admin: Db;
  let userA: TestUser;
  let userB: TestUser;
  const createdUserIds: string[] = [];

  // Populated by the service-role seed, then read by the isolation tests.
  let aMeetingId: string;
  let aEventId: string;
  let bEventId: string;

  /** Admin-create a confirmed user, then sign in a per-user (JWT) client for them. */
  async function createTestUser(label: string): Promise<TestUser> {
    const suffix = randomUUID();
    const email = `usage-rls-${label}-${suffix}@nova.test`;
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

  /** Service-role teardown: usage_events FK meetings+profiles (NO ACTION), so delete
   * usage_events first, then meetings, then the auth user (cascades the profile). */
  async function purgeUser(userId: string): Promise<void> {
    await admin.from("usage_events").delete().eq("user_id", userId);
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

    // A owns a meeting to attribute a usage row to.
    const meeting = unwrap(
      await userA.client
        .from("meetings")
        .insert({
          user_id: userA.id,
          title: "A meeting for usage posture test",
        })
        .select()
        .single(),
      "A insert meeting",
    );
    aMeetingId = meeting.id;

    // Service-role seeds one usage row for each user (writes are service-role-only).
    const aEvent = unwrap(
      await admin
        .from("usage_events")
        .insert({
          user_id: userA.id,
          meeting_id: aMeetingId,
          vendor: "openai",
          kind: "llm_tokens",
          amount: 1500,
          input_amount: 1000,
          output_amount: 500,
          model: "gpt-5.4-mini",
          cost_estimate_usd: 0.00045,
        })
        .select()
        .single(),
      "service-role insert A usage",
    );
    aEventId = aEvent.id;

    const bEvent = unwrap(
      await admin
        .from("usage_events")
        .insert({
          user_id: userB.id,
          vendor: "assemblyai",
          kind: "stt_seconds",
          amount: 60,
          cost_estimate_usd: 0.0025,
        })
        .select()
        .single(),
      "service-role insert B usage",
    );
    bEventId = bEvent.id;
  });

  afterAll(async () => {
    for (const id of createdUserIds) {
      await purgeUser(id);
    }
  });

  it("[usage-service-role] service_role reads back both seeded rows with defaults", async () => {
    const aRow = unwrap(
      await admin.from("usage_events").select().eq("id", aEventId).single(),
      "service-role read A usage",
    );
    expect(aRow.user_id).toBe(userA.id);
    expect(aRow.kind).toBe("llm_tokens");
    expect(aRow.amount).toBe(1500);
    expect(aRow.meeting_id).toBe(aMeetingId);

    const bRow = unwrap(
      await admin.from("usage_events").select().eq("id", bEventId).single(),
      "service-role read B usage",
    );
    expect(bRow.user_id).toBe(userB.id);
    // meeting_id defaults to null when omitted.
    expect(bRow.meeting_id).toBeNull();
  });

  it("[usage-select-own] A's JWT sees ONLY A's rows (B's are invisible)", async () => {
    const rows = unwrap(
      await userA.client.from("usage_events").select(),
      "A select usage",
    );
    // A sees at least its own seeded row and NONE that belong to B.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.user_id === userA.id)).toBe(true);
    expect(rows.some((r) => r.id === aEventId)).toBe(true);
    expect(rows.some((r) => r.id === bEventId)).toBe(false);
  });

  it("[usage-isolation] B's JWT sees ZERO of A's rows", async () => {
    const res = await userB.client
      .from("usage_events")
      .select()
      .eq("id", aEventId);
    expect(res.error).toBeNull();
    expect(res.data ?? []).toHaveLength(0);
  });

  it("[usage-posture] A's JWT cannot INSERT a usage row (denied; nothing written)", async () => {
    const res = await userA.client
      .from("usage_events")
      .insert({
        user_id: userA.id,
        vendor: "openai",
        kind: "llm_tokens",
        amount: 999,
      })
      .select();

    // No insert policy + no insert grant → PostgREST denies; nothing written.
    expect(res.error).not.toBeNull();
    expect(res.data ?? []).toHaveLength(0);

    // Service role confirms only the ONE service-role-seeded row exists for A.
    const rows = unwrap(
      await admin.from("usage_events").select().eq("user_id", userA.id),
      "service-role read A usage rows",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(aEventId);
  });

  it("[usage-check] a usage row with a bogus kind is rejected by the CHECK", async () => {
    const res = await admin
      .from("usage_events")
      .insert({
        user_id: userA.id,
        vendor: "openai",
        kind: "not_a_real_kind",
        amount: 1,
      })
      .select();

    expect(res.error).not.toBeNull();
    expect(res.data ?? []).toHaveLength(0);
  });

  it("[plan-check] a profile plan out of set is rejected by profiles_plan_check", async () => {
    const res = await admin
      .from("profiles")
      .update({ plan: "enterprise" })
      .eq("id", userA.id)
      .select();

    expect(res.error).not.toBeNull();
    expect(res.error?.message ?? "").toContain("profiles_plan_check");
    // A's plan is untouched (still the default 'free').
    const after = unwrap(
      await admin.from("profiles").select().eq("id", userA.id).single(),
      "service-role re-read profile",
    );
    expect(after.plan).toBe("free");
  });
});
