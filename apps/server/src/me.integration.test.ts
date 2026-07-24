import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

/**
 * End-to-end proof that the server's ES256/JWKS verification accepts a REAL
 * Supabase-issued access token (not just our self-signed fixtures). We admin-
 * create a user, sign them in through the anon client to mint a genuine token,
 * then call the in-process `/me` route with it.
 *
 * Requires the local stack env: SUPABASE_URL (the server fetches its JWKS from
 * here to verify the token) + SERVICE_ROLE_KEY (create the user) + ANON_KEY
 * (sign in). The suite skips unless all three are present, so `npm run test`
 * stays green stack-down.
 */

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const hasStack = Boolean(url && serviceRoleKey && anonKey);

const noPersist = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

describe.skipIf(!hasStack)(
  "GET /me with a real Supabase token (local stack)",
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

      const email = `me-${randomUUID()}@nova.test`;
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
      if (userId) {
        await admin.auth.admin.deleteUser(userId);
      }
    });

    it("resolves the real token to the matching user id", async () => {
      const app = buildApp({ logger: false });
      try {
        const response = await app.inject({
          method: "GET",
          url: "/me",
          headers: { authorization: `Bearer ${accessToken}` },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json<{ user_id: string }>();
        expect(body.user_id).toBe(userId);
      } finally {
        await app.close();
      }
    });

    it("exposes the default role 'customer' for a fresh user (adr-0008)", async () => {
      // SUPABASE_DB_URL gates the role reader; without it the field is simply
      // absent — assert only when this run has the full stack.
      if (!process.env.SUPABASE_DB_URL) return;
      const app = buildApp({ logger: false });
      try {
        const response = await app.inject({
          method: "GET",
          url: "/me",
          headers: { authorization: `Bearer ${accessToken}` },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json<{ user_id: string; role?: string }>();
        expect(body.role).toBe("customer");
      } finally {
        await app.close();
      }
    });
  },
);
