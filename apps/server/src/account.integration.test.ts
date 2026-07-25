import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

/**
 * End-to-end proof of `DELETE /account` against the RUNNING local stack: a real
 * user signs in, calls the in-process route with their genuine token, and we
 * assert the side effects with the service-role client — the queued
 * `deletion_requests` row (pending) and the tombstoned profile. A second call
 * proves idempotency (still 202, no duplicate pending row); no token proves 401.
 *
 * Requires the local stack env (SUPABASE_URL + SERVICE_ROLE_KEY + ANON_KEY);
 * the suite skips unless all three are present, so `npm run test` stays green
 * stack-down (same skipIf posture as me.integration.test.ts).
 */

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const hasStack = Boolean(url && serviceRoleKey && anonKey);

const noPersist = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

describe.skipIf(!hasStack)(
  "DELETE /account with a real Supabase token (local stack)",
  () => {
    let admin: ReturnType<typeof createClient>;
    let userId: string;
    let accessToken: string;

    beforeAll(async () => {
      // skipIf guarantees these; narrow for the type checker.
      if (!url || !serviceRoleKey || !anonKey) {
        throw new Error("Supabase stack env vars missing");
      }
      admin = createClient(url, serviceRoleKey, noPersist);

      const email = `del-${randomUUID()}@nova.test`;
      const password = `Pw-${randomUUID()}`;
      const created = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (created.error) {
        throw new Error(`createUser failed: ${created.error.message}`);
      }
      userId = created.data.user.id;

      const anon = createClient(url, anonKey, noPersist);
      const signIn = await anon.auth.signInWithPassword({ email, password });
      if (signIn.error) {
        throw new Error(`signIn failed: ${signIn.error.message}`);
      }
      accessToken = signIn.data.session.access_token;
    });

    afterAll(async () => {
      if (!userId) return;
      // Purge-order contract: the deletion_requests FK to profiles is NO ACTION,
      // so the queue row must go BEFORE deleting the auth user (whose cascade
      // would otherwise be blocked by that reference).
      await admin.from("deletion_requests").delete().eq("user_id", userId);
      await admin.auth.admin.deleteUser(userId);
    });

    it("queues the deletion, tombstones the profile, and is idempotent", async () => {
      const app = buildApp({ logger: false });
      try {
        // No token -> 401 (protected route).
        const unauth = await app.inject({ method: "DELETE", url: "/account" });
        expect(unauth.statusCode).toBe(401);

        // First delete -> 202 queued.
        const first = await app.inject({
          method: "DELETE",
          url: "/account",
          headers: { authorization: `Bearer ${accessToken}` },
        });
        expect(first.statusCode).toBe(202);
        const firstBody = first.json<{ status: string; request_id: string }>();
        expect(firstBody.status).toBe("queued");
        expect(firstBody.request_id).toMatch(/^[0-9a-f-]{36}$/);

        // Service-role assertions: exactly one pending queue row for this user.
        const pending = await admin
          .from("deletion_requests")
          .select("id, user_id, processed_at")
          .eq("user_id", userId)
          .is("processed_at", null)
          // The admin client is built without a `Database` generic, so rows
          // infer as `never`; name the columns we selected (RULES §1 house
          // style: explicit columns, shape stated at the boundary).
          .overrideTypes<
            { id: string; user_id: string; processed_at: string | null }[],
            { merge: false }
          >();
        expect(pending.error).toBeNull();
        expect(pending.data).toHaveLength(1);
        expect(pending.data?.[0]?.id).toBe(firstBody.request_id);
        expect(pending.data?.[0]?.processed_at).toBeNull();

        // Profile is tombstoned.
        const profile = await admin
          .from("profiles")
          .select("id, deleted_at")
          .eq("id", userId)
          .single()
          .overrideTypes<
            { id: string; deleted_at: string | null },
            { merge: false }
          >();
        expect(profile.error).toBeNull();
        expect(profile.data?.deleted_at).not.toBeNull();

        // Second delete -> still 202, and NO duplicate pending row.
        const second = await app.inject({
          method: "DELETE",
          url: "/account",
          headers: { authorization: `Bearer ${accessToken}` },
        });
        expect(second.statusCode).toBe(202);
        const secondBody = second.json<{ request_id: string }>();
        expect(secondBody.request_id).toBe(firstBody.request_id);

        const stillOne = await admin
          .from("deletion_requests")
          .select("id")
          .eq("user_id", userId)
          .is("processed_at", null);
        expect(stillOne.data).toHaveLength(1);
      } finally {
        await app.close();
      }
    }, 20000); // Two full delete flows + admin ops + two live signOut calls.
  },
);
