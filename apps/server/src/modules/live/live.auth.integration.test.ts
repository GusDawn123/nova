import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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
import type { ServerLiveEvent } from "@nova/shared";

import { buildApp } from "../../app.js";

/**
 * Auth at WS-upgrade time (the REAL `authenticateToken`, not stubbed). A WS has
 * no clean HTTP 401 after upgrade, so failures are policy closes with app codes:
 * 4401 unauthorized, 4503 unavailable. The happy path with a genuine Supabase
 * JWT runs only when the local stack is up (skipIf, mirroring me.integration).
 */

const DUMMY_URL = "http://127.0.0.1:54321";

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
    opts.bearer
      ? { headers: { authorization: `Bearer ${opts.bearer}` } }
      : undefined,
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
// REAL Supabase-issued tokens (local stack only): the meeting-ownership guard
// (Phase 4 review C1) proven end to end against the DB-wired transport.
//
// The persist path is service-role (RLS + the DB parentage `with_check` are
// BYPASSED), so the socket must itself confirm the `session.start` meeting_id is a
// live meeting owned by the caller BEFORE any STT/persistence. These two tests
// prove: (happy) an owner opens a session on their own meeting; (A/B) user B is
// REFUSED a session on user A's meeting and NO transcript row lands under it.
// ---------------------------------------------------------------------------
const stackUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const hasStack = Boolean(stackUrl && serviceRoleKey && anonKey);

const noPersist = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

// Minimal hand-written `Database` (mirrors the sibling DB suites — kept local so
// `.from(...)` stays type-safe under strict-type-checked eslint). MUST be `type`
// aliases, not `interface`s (supabase-js's `GenericTable` constrains `Row` to
// `Record<string, unknown>`, which interfaces do not satisfy).
type MeetingRow = {
  id: string;
  user_id: string;
  title: string;
  started_at: string | null;
  ended_at: string | null;
  indexed_at: string | null;
  created_at: string;
  deleted_at: string | null;
};
type TranscriptRow = {
  id: string;
  meeting_id: string;
  user_id: string;
  content: string;
  speaker: string | null;
  ts_ms: number | null;
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

/** Resolve once the socket is open (or reject on a connect error). */
function openReady(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.on("open", () => {
      resolve();
    });
    ws.on("error", reject);
  });
}

/** The first JSON server event pushed down the socket. */
function firstEvent(ws: WebSocket): Promise<ServerLiveEvent> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data: Buffer) => {
      try {
        resolve(JSON.parse(data.toString("utf8")) as ServerLiveEvent);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

const startFrame = (meetingId: string): string =>
  JSON.stringify({ v: 1, type: "session.start", meeting_id: meetingId });

describe.skipIf(!hasStack)(
  "GET /live meeting-ownership guard (local stack)",
  () => {
    let admin: SupabaseClient<Database>;
    let userAId: string;
    let userBId: string;
    let tokenA: string;
    let tokenB: string;
    let meetingAId: string;
    const createdUserIds: string[] = [];

    /** Admin-create a confirmed user and sign them in for an access token. */
    async function createUser(
      label: string,
    ): Promise<{ id: string; token: string }> {
      if (!stackUrl || !anonKey) {
        throw new Error("Supabase stack env vars missing");
      }
      const email = `live-${label}-${randomUUID()}@nova.test`;
      const password = `Pw-${randomUUID()}`;
      const created = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (created.error) {
        throw new Error(
          `createUser(${label}) failed: ${created.error.message}`,
        );
      }
      const anon = createClient(stackUrl, anonKey, noPersist);
      const signIn = await anon.auth.signInWithPassword({ email, password });
      if (signIn.error) {
        throw new Error(`signIn(${label}) failed: ${signIn.error.message}`);
      }
      return {
        id: created.data.user.id,
        token: signIn.data.session.access_token,
      };
    }

    beforeAll(async () => {
      if (!stackUrl || !serviceRoleKey || !anonKey) {
        throw new Error("Supabase stack env vars missing");
      }
      admin = createClient<Database>(stackUrl, serviceRoleKey, noPersist);

      const a = await createUser("a");
      userAId = a.id;
      tokenA = a.token;
      createdUserIds.push(userAId);

      const b = await createUser("b");
      userBId = b.id;
      tokenB = b.token;
      createdUserIds.push(userBId);

      // A meeting owned by A (service role — the trigger auto-provisions A's profile).
      const meeting = await admin
        .from("meetings")
        .insert({ user_id: userAId, title: "A's live call" })
        .select("id")
        .single();
      if (meeting.error) {
        throw new Error(`insert meeting failed: ${meeting.error.message}`);
      }
      meetingAId = meeting.data.id;
    });

    afterAll(async () => {
      // FKs are NO ACTION → delete children before the auth row.
      for (const id of createdUserIds) {
        await admin.from("transcripts").delete().eq("user_id", id);
        await admin.from("meetings").delete().eq("user_id", id);
        await admin.auth.admin.deleteUser(id);
      }
    });

    it("[ownership-happy] the owner opens a session on their own meeting", async () => {
      const ws = open({ bearer: tokenA });
      try {
        await openReady(ws);
        ws.send(startFrame(meetingAId));
        const event = await firstEvent(ws);
        expect(event.type).toBe("session.ready");
      } finally {
        ws.terminate();
      }
    });

    it("[ownership-spoof] B cannot start a session on A's meeting; no transcript lands", async () => {
      const ws = open({ bearer: tokenB });
      try {
        await openReady(ws);
        // B is authenticated, but the meeting belongs to A → refused before any STT
        // starts. B never receives session.ready; the first event is the typed error.
        ws.send(startFrame(meetingAId));
        const event = await firstEvent(ws);
        expect(event).toMatchObject({
          type: "error",
          code: "meeting_forbidden",
        });
      } finally {
        ws.terminate();
      }

      // The service-role read (bypasses RLS) proves nothing was written against A's
      // meeting — B's spoofed session never opened a transcript write path.
      const rows = await admin
        .from("transcripts")
        .select("id")
        .eq("meeting_id", meetingAId);
      expect(rows.error).toBeNull();
      expect(rows.data ?? []).toHaveLength(0);
    });
  },
);
