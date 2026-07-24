import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Profiles grant/role posture proof (adr-0008 + the 20260723100000 security
 * fix) — the column-scoped-UPDATE sibling of the RLS isolation A/B suite. These
 * tests hit Supabase/PostgREST DIRECTLY with a real user's JWT, so the
 * guarantee under test is the Postgres GRANT itself, not application code:
 *
 *   - a user READS their own `role` (select still table-wide);
 *   - `UPDATE plan` on their OWN row → permission denied (the free→pro
 *     self-upgrade hole is CLOSED);
 *   - `UPDATE role` on their OWN row → permission denied (no self-promotion);
 *   - `UPDATE display_name` still works (the re-granted column);
 *   - service_role can still set `role` (the assignment path).
 *
 * Requires the full stack env; skips without it (isolation-suite convention).
 */

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const hasStack = Boolean(url && serviceRoleKey && anonKey);

// Minimal `Database` type (MUST be `type` aliases — the GenericTable constraint).
type ProfileRow = {
  id: string;
  display_name: string | null;
  plan: string;
  role: string;
  created_at: string;
  deleted_at: string | null;
};
type Database = {
  public: {
    Tables: {
      profiles: {
        Row: ProfileRow;
        Insert: { id: string };
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

const noPersist = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

describe.skipIf(!hasStack)(
  "profiles grants + role posture (local stack)",
  () => {
    let admin: SupabaseClient<Database>;
    let userClient: SupabaseClient<Database>;
    let userId: string;

    beforeAll(async () => {
      if (!url || !serviceRoleKey || !anonKey) {
        throw new Error("stack env missing");
      }
      admin = createClient<Database>(url, serviceRoleKey, noPersist);

      const email = `grants-${randomUUID()}@nova.test`;
      const password = `Pw-${randomUUID()}`;
      const created = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (created.error)
        throw new Error(`createUser: ${created.error.message}`);
      userId = created.data.user.id;

      userClient = createClient<Database>(url, anonKey, noPersist);
      const signIn = await userClient.auth.signInWithPassword({
        email,
        password,
      });
      if (signIn.error) throw new Error(`signIn: ${signIn.error.message}`);
    });

    afterAll(async () => {
      await admin.auth.admin.deleteUser(userId);
    });

    it("[grants] a user reads their own role (default 'customer')", async () => {
      const res = await userClient
        .from("profiles")
        .select("id, role, plan")
        .eq("id", userId)
        .single();
      expect(res.error).toBeNull();
      expect(res.data?.role).toBe("customer");
      expect(res.data?.plan).toBe("free");
    });

    it("[grants] UPDATE plan on the user's OWN row is permission denied (the security fix)", async () => {
      const res = await userClient
        .from("profiles")
        .update({ plan: "pro" })
        .eq("id", userId)
        .select("plan");
      // Column-scoped grant: 42501 permission denied — NOT a silent no-op.
      expect(res.error).not.toBeNull();
      expect(res.error?.code).toBe("42501");

      // And the row is untouched (service-role read, bypasses RLS).
      const check = await admin
        .from("profiles")
        .select("plan")
        .eq("id", userId)
        .single();
      expect(check.data?.plan).toBe("free");
    });

    it("[grants] UPDATE role on the user's OWN row is permission denied (no self-promotion)", async () => {
      const res = await userClient
        .from("profiles")
        .update({ role: "admin" })
        .eq("id", userId)
        .select("role");
      expect(res.error).not.toBeNull();
      expect(res.error?.code).toBe("42501");

      const check = await admin
        .from("profiles")
        .select("role")
        .eq("id", userId)
        .single();
      expect(check.data?.role).toBe("customer");
    });

    it("[grants] UPDATE display_name still works (the re-granted column)", async () => {
      const res = await userClient
        .from("profiles")
        .update({ display_name: "Grant Posture" })
        .eq("id", userId)
        .select("display_name")
        .single();
      expect(res.error).toBeNull();
      expect(res.data?.display_name).toBe("Grant Posture");
    });

    it("[grants] service_role can set role (the assignment path)", async () => {
      const res = await admin
        .from("profiles")
        .update({ role: "developer" })
        .eq("id", userId)
        .select("role")
        .single();
      expect(res.error).toBeNull();
      expect(res.data?.role).toBe("developer");
      // Restore for hygiene.
      await admin
        .from("profiles")
        .update({ role: "customer" })
        .eq("id", userId);
    });
  },
);
