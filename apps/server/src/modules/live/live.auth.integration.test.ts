import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import { createClient } from "@supabase/supabase-js";
import type { ServerLiveEvent } from "@nova/shared";
import type { FastifyInstance } from "fastify";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { WebSocket } from "ws";

import { buildApp } from "../../app.js";

/**
 * Auth at WS-upgrade time (the REAL `authenticateToken`, not stubbed). A WS has
 * no clean HTTP 401 after upgrade, so failures are policy closes with app codes:
 * 4401 unauthorized, 4503 unavailable. The happy path with a genuine Supabase
 * JWT runs only when the local stack is up (skipIf, mirroring me.integration).
 */

const DUMMY_URL = "http://127.0.0.1:54321";
const MEETING_ID = "11111111-1111-4111-8111-111111111111";

let app: FastifyInstance;
let wsUrl: string;

beforeEach(async () => {
  app = buildApp({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${String(address.port)}/live`;
});

afterEach(async () => {
  await app.close();
});

/** Open a socket with optional Authorization header / query token. */
function open(opts: { bearer?: string; query?: string } = {}): WebSocket {
  const url = opts.query ? `${wsUrl}?token=${opts.query}` : wsUrl;
  const ws = new WebSocket(
    url,
    opts.bearer ? { headers: { authorization: `Bearer ${opts.bearer}` } } : undefined,
  );
  // A policy close is a normal close handshake, but guard against stray errors.
  ws.on("error", () => undefined);
  return ws;
}

function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code: number, reason: Buffer) => {
      resolve({ code, reason: reason.toString("utf8") });
    });
  });
}

describe("GET /live auth close codes", () => {
  describe("without SUPABASE_URL", () => {
    beforeEach(() => {
      vi.stubEnv("SUPABASE_URL", "");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("closes 4503 (unavailable) even with a token present", async () => {
      const ws = open({ bearer: "anything" });
      try {
        const { code, reason } = await nextClose(ws);
        expect(code).toBe(4503);
        expect(reason).toBe("unavailable");
      } finally {
        ws.terminate();
      }
    });
  });

  describe("with SUPABASE_URL configured", () => {
    beforeEach(() => {
      vi.stubEnv("SUPABASE_URL", DUMMY_URL);
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("closes 4401 when no token is provided", async () => {
      const ws = open();
      try {
        const { code, reason } = await nextClose(ws);
        expect(code).toBe(4401);
        expect(reason).toBe("unauthorized");
      } finally {
        ws.terminate();
      }
    });

    it("closes 4401 for a garbage bearer token", async () => {
      const ws = open({ bearer: "garbage.not.jwt" });
      try {
        expect((await nextClose(ws)).code).toBe(4401);
      } finally {
        ws.terminate();
      }
    });

    it("closes 4401 for a garbage ?token= query param", async () => {
      const ws = open({ query: "garbage.not.jwt" });
      try {
        expect((await nextClose(ws)).code).toBe(4401);
      } finally {
        ws.terminate();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Happy path with a REAL Supabase-issued token (local stack only).
// ---------------------------------------------------------------------------
const stackUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const hasStack = Boolean(stackUrl && serviceRoleKey && anonKey);

const noPersist = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

describe.skipIf(!hasStack)(
  "GET /live with a real Supabase token (local stack)",
  () => {
    let admin: ReturnType<typeof createClient>;
    let userId: string;
    let accessToken: string;

    beforeAll(async () => {
      if (!stackUrl || !serviceRoleKey || !anonKey) {
        throw new Error("Supabase stack env vars missing");
      }
      admin = createClient(stackUrl, serviceRoleKey, noPersist);

      const email = `live-${randomUUID()}@nova.test`;
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

      const anon = createClient(stackUrl, anonKey, noPersist);
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

    it("upgrades and completes the handshake with a valid token", async () => {
      const ws = open({ bearer: accessToken });
      try {
        await new Promise<void>((resolve, reject) => {
          ws.on("open", () => {
            resolve();
          });
          ws.on("error", reject);
        });
        ws.send(
          JSON.stringify({
            v: 1,
            type: "session.start",
            meeting_id: MEETING_ID,
          }),
        );
        const ready = await new Promise<ServerLiveEvent>((resolve, reject) => {
          ws.once("message", (data: Buffer) => {
            try {
              resolve(JSON.parse(data.toString("utf8")) as ServerLiveEvent);
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          });
        });
        expect(ready.type).toBe("session.ready");
      } finally {
        ws.terminate();
      }
    });
  },
);
