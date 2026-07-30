import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { ServerLiveEvent } from "@nova/shared";

import { buildApp } from "../../app.js";
import { notesConductorConfig } from "./notes-conductor-config.js";

/**
 * KEY + DB-GATED end-to-end proof that live notes are actually WIRED (Phase 8
 * slice 4, docs/DESIGN/live-notes.md §10 "Wire/integration").
 *
 * Slices 2 and 3 were inert by design — the schema, the store, the fold and the
 * loop all existed with nothing constructing them. This is the test that proves
 * the wiring closed the circuit: a REAL authed WebSocket against the REAL app
 * (real Supabase JWT, real session gates, real fold, real live-tier router)
 * streams `notes.update` and leaves a `live_notes` row behind.
 *
 * It also proves the ENTITLEMENT in the only way that counts: a `free` user on
 * the identical path gets zero `notes.update` and zero rows. An entitlement that
 * is only unit-tested is an entitlement you find out about on the bill.
 *
 * Runs ONLY with the local stack + an LLM key; keyless CI skips cleanly.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const stackUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const dbUrl = process.env.SUPABASE_DB_URL;
const hasLlm = Boolean(
  process.env.OPENAI_API_KEY || process.env.GOOGLE_API_KEY,
);
const canRun = Boolean(
  stackUrl && serviceRoleKey && anonKey && dbUrl && hasLlm,
);

const noPersist = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

/** Minimal hand-written `Database` — MUST be `type` aliases (GenericTable). */
type MeetingRow = { id: string; user_id: string; title: string };
type ProfileRow = { id: string; plan: string };
type LiveNotesRow = {
  meeting_id: string;
  user_id: string;
  notes: unknown;
  rev: number;
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
      profiles: {
        Row: ProfileRow;
        Insert: Partial<ProfileRow>;
        Update: Partial<ProfileRow>;
        Relationships: [];
      };
      live_notes: {
        Row: LiveNotesRow;
        Insert: Partial<LiveNotesRow>;
        Update: Partial<LiveNotesRow>;
        Relationships: [];
      };
      transcripts: {
        Row: { id: string; user_id: string };
        Insert: Partial<{ id: string; user_id: string }>;
        Update: Partial<{ id: string; user_id: string }>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

/**
 * A short scripted call with unmistakable substance — commitments, a number and
 * a date, so the gate fires on the first delta rather than waiting for the
 * force-fire ceiling.
 */
const SCRIPT = [
  "So we walked through the numbers and the annual plan comes to 47500 for twelve months.",
  "Right, and we decided to go with the annual plan rather than monthly.",
  "I'll send the contract over by Friday, and Priya will handle the migration.",
];

/** One fold interval plus generous slack for the model call itself. */
const FOLD_WINDOW_MS = notesConductorConfig.foldIntervalMs + 60_000;

/**
 * Proving ABSENCE only needs to outlast the first tick: entitlement is resolved
 * there and stops the loop before any model call, so there is no round trip to
 * wait out. Shorter than {@link FOLD_WINDOW_MS} on purpose — this window is spent
 * in full every run.
 */
const NO_FOLD_WINDOW_MS = notesConductorConfig.foldIntervalMs + 15_000;

describe.skipIf(!canRun)("live notes e2e (real socket + real LLM)", () => {
  let app: FastifyInstance;
  let wsUrl: string;
  let admin: SupabaseClient<Database>;
  const userIds: string[] = [];

  /** Mint a user on `plan`, plus a meeting, and return a real JWT. */
  async function seedUser(
    label: string,
    plan: "free" | "pro",
  ): Promise<{ userId: string; token: string; meetingId: string }> {
    if (!stackUrl || !anonKey) throw new Error("stack env missing");
    const email = `live-notes-${label}-${randomUUID()}@nova.test`;
    const password = `Pw-${randomUUID()}`;
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (created.error) throw new Error(created.error.message);
    const userId = created.data.user.id;
    userIds.push(userId);

    // The entitlement under test. `plan` is service-role-only (the profiles
    // grant fix in 20260723100000), which is exactly why it is set here.
    const upgraded = await admin
      .from("profiles")
      .update({ plan })
      .eq("id", userId);
    if (upgraded.error) throw new Error(upgraded.error.message);

    const anon = createClient(stackUrl, anonKey, noPersist);
    const signIn = await anon.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(signIn.error.message);

    const meeting = await admin
      .from("meetings")
      .insert({ user_id: userId, title: `live notes e2e (${plan})` })
      .select("id")
      .single();
    if (meeting.error) throw new Error(meeting.error.message);

    return {
      userId,
      token: signIn.data.session.access_token,
      meetingId: meeting.data.id,
    };
  }

  /**
   * Drive the scripted call over a real socket. Resolves on the first
   * `notes.update`, or after `windowMs` with whatever arrived (so the
   * entitlement case can assert ABSENCE without failing on a timeout).
   */
  async function runCall(
    token: string,
    meetingId: string,
    windowMs: number,
  ): Promise<ServerLiveEvent[]> {
    const events: ServerLiveEvent[] = [];
    const ws = new WebSocket(wsUrl, {
      headers: { authorization: `Bearer ${token}` },
    });
    ws.on("error", () => undefined);

    await new Promise<void>((resolve, reject) => {
      const done = setTimeout(resolve, windowMs);
      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            v: 1,
            type: "session.start",
            meeting_id: meetingId,
          }),
        );
      });
      ws.on("message", (data: Buffer) => {
        const event = JSON.parse(data.toString("utf8")) as ServerLiveEvent;
        events.push(event);
        if (event.type === "session.ready") {
          // Typed input rides the same path as a real STT final (origin
          // "utterance"), so this exercises the true consumer fan-out.
          for (const text of SCRIPT) {
            ws.send(
              JSON.stringify({
                v: 1,
                type: "transcript.input",
                text,
                origin: "utterance",
              }),
            );
          }
        }
        if (event.type === "notes.update") {
          clearTimeout(done);
          resolve();
        }
        if (event.type === "error") {
          clearTimeout(done);
          reject(new Error(`live error: ${event.code} ${event.message}`));
        }
      });
    }).finally(() => {
      ws.terminate();
    });

    return events;
  }

  beforeAll(async () => {
    if (!stackUrl || !serviceRoleKey) throw new Error("stack env missing");
    admin = createClient<Database>(stackUrl, serviceRoleKey, noPersist);
    app = buildApp({ logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as AddressInfo;
    wsUrl = `ws://127.0.0.1:${String(address.port)}/live`;
  });

  afterAll(async () => {
    await app.close();
    for (const userId of userIds) {
      // Child-first, matching the FK order.
      await admin.from("live_notes").delete().eq("user_id", userId);
      await admin.from("transcripts").delete().eq("user_id", userId);
      await admin.from("meetings").delete().eq("user_id", userId);
      await admin.auth.admin.deleteUser(userId);
    }
  });

  it("[notes-e2e] a pro call streams notes.update and persists live_notes", async () => {
    const { userId, token, meetingId } = await seedUser("pro", "pro");
    const events = await runCall(token, meetingId, FOLD_WINDOW_MS);

    const updates = events.filter((e) => e.type === "notes.update");
    console.log(
      `[notes-e2e] updates=${String(updates.length)} events=${String(events.length)}`,
    );
    expect(updates.length).toBeGreaterThan(0);

    const first = updates[0];
    if (first?.type !== "notes.update")
      throw new Error("expected notes.update");
    expect(first.rev).toBeGreaterThanOrEqual(1);
    expect(first.notes.version).toBe(2);
    // The preview marker — this is what the tab keys its "still forming" state off.
    expect(first.notes.source).toBe("live");
    // The narrative window is open on the FIRST fold, so the placeholder title
    // and tldr must not have survived it.
    expect(first.notes.tldr).not.toBe("Notes are still forming.");

    // The fold captured something from a script that is nothing but substance.
    const items =
      first.notes.decisions.length +
      first.notes.actionItems.length +
      first.notes.openQuestions.length +
      first.notes.risks.length;
    console.log(
      `[notes-e2e] rev=${String(first.rev)} items=${String(items)} title="${first.notes.title}" tldr="${first.notes.tldr}"`,
    );
    expect(items).toBeGreaterThan(0);

    // And it landed in the table, at the rev the socket announced.
    const row = await admin
      .from("live_notes")
      .select("rev, user_id")
      .eq("meeting_id", meetingId)
      .single();
    expect(row.error).toBeNull();
    expect(row.data?.rev).toBe(first.rev);
    expect(row.data?.user_id).toBe(userId);
  });

  it("[notes-e2e] a free call gets NO notes.update and writes NO row", async () => {
    // The entitlement, end to end. The same script over the same path — the only
    // difference is `profiles.plan`.
    const { userId, token, meetingId } = await seedUser("free", "free");
    const events = await runCall(token, meetingId, NO_FOLD_WINDOW_MS);

    expect(events.filter((e) => e.type === "notes.update")).toHaveLength(0);

    const rows = await admin
      .from("live_notes")
      .select("meeting_id")
      .eq("user_id", userId);
    expect(rows.error).toBeNull();
    expect(rows.data ?? []).toHaveLength(0);
  });
});
