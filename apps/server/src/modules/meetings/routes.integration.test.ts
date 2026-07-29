import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  identifyNotes,
  meetingListResponseSchema,
  meetingTranscriptResponseSchema,
  type MeetingNotes,
} from "@nova/shared";

import { createMeetingsReader } from "../../db/meetings.js";

import type { MeetingsLogger } from "./ports.js";
import { createMeetingsRoutes } from "./routes.js";

/**
 * Route integration suite (playbook VERIFY) for the meetings read surface — REAL
 * local Supabase Postgres through the real adapter, REAL Supabase-issued JWTs
 * through `requireAuth`. No vendor key is involved: these routes call no provider,
 * which is exactly why they register on a keyless boot.
 *
 * Proves the contract the Meetings screen depends on: the projection shape, newest-
 * first ordering with nullable `started_at`, soft-delete exclusion, user scoping,
 * the live-notes tldr fallback, the month counter, the page cap, and the uniform
 * 404 trio on the transcript route — plus the distinction the route exists to make,
 * that an EMPTY transcript is a 200 and not a 404.
 *
 * Self-skips without the stack env so `npm run test` stays green (isolation-suite
 * convention).
 */

const dbUrl = process.env.SUPABASE_DB_URL;
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const hasStack = Boolean(dbUrl && url && serviceRoleKey && anonKey);

const noPersist = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

/** Build notes with a given tldr/type/action-item count. */
function notesWith(
  tldr: string,
  kind: "sales" | "interview",
  actionItemCount: number,
  source: "generated" | "live" = "generated",
): MeetingNotes {
  return identifyNotes(
    {
      conversationType: kind,
      title: "Northwind discovery",
      tldr,
      overview: "Discovery call covering budget and timeline.",
      decisions: [],
      actionItems: Array.from({ length: actionItemCount }, (_, i) => ({
        text: `Action ${String(i + 1)}.`,
        owner: null,
        deadline: null,
        deadlineRaw: null,
        quote: null,
      })),
      openQuestions: [],
      risks: [],
      typeInsights:
        kind === "sales"
          ? { kind: "sales", objections: [], buyingSignals: [] }
          : { kind: "interview", questionsAsked: [], answersToRevisit: [] },
    },
    source,
  );
}

interface CapturedLog {
  fields: Record<string, unknown>;
  msg: string;
}
function capturingLogger(): { logger: MeetingsLogger; lines: CapturedLog[] } {
  const lines: CapturedLog[] = [];
  return {
    lines,
    logger: {
      info: (fields, msg) => lines.push({ fields, msg }),
      error: (fields, msg) => lines.push({ fields, msg }),
    },
  };
}

describe.skipIf(!hasStack)("meetings REST routes (local stack)", () => {
  let pool: Pool;
  let admin: ReturnType<typeof createClient>;
  let app: FastifyInstance;
  let log: { logger: MeetingsLogger; lines: CapturedLog[] };

  let tokenA: string;
  let userAId: string;
  // User B exists to prove isolation; only their id is ever needed (their rows are
  // seeded through the service-role pool, never through their own JWT).
  let userBId: string;
  const userIds: string[] = [];

  // The clock every case reasons against; the month counter is derived from it.
  const NOW = new Date("2026-07-22T18:00:00Z");

  async function createUser(
    label: string,
  ): Promise<{ id: string; token: string }> {
    if (!url || !anonKey) throw new Error("stack env missing");
    const email = `mtg-${label}-${randomUUID()}@nova.test`;
    const password = `Pw-${randomUUID()}`;
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (created.error) throw new Error(`createUser: ${created.error.message}`);
    const anon = createClient(url, anonKey, noPersist);
    const signIn = await anon.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`signIn: ${signIn.error.message}`);
    return {
      id: created.data.user.id,
      token: signIn.data.session.access_token,
    };
  }

  /** Insert a meeting with explicit timestamps so ordering is deterministic. */
  async function newMeeting(
    ownerId: string,
    title: string,
    startedAt: string | null,
    endedAt: string | null = null,
  ): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `insert into meetings (user_id, title, started_at, ended_at, notes_status)
       values ($1, $2, $3::timestamptz, $4::timestamptz, 'none') returning id`,
      [ownerId, title, startedAt, endedAt],
    );
    const id = r.rows[0]?.id;
    if (id === undefined) throw new Error("meeting insert returned no id");
    return id;
  }

  async function setNotes(
    meetingId: string,
    notes: MeetingNotes,
    status = "completed",
  ): Promise<void> {
    await pool.query(
      `update meetings set notes = $2::jsonb, notes_status = $3,
         notes_generated_at = now() where id = $1`,
      [meetingId, JSON.stringify(notes), status],
    );
  }

  async function setLiveNotes(
    meetingId: string,
    ownerId: string,
    notes: MeetingNotes,
    rev = 3,
  ): Promise<void> {
    await pool.query(
      `insert into live_notes (meeting_id, user_id, notes, rev)
       values ($1, $2, $3::jsonb, $4)`,
      [meetingId, ownerId, JSON.stringify(notes), rev],
    );
  }

  async function addTurn(
    meetingId: string,
    ownerId: string,
    speaker: string | null,
    tsMs: number | null,
    content: string,
  ): Promise<void> {
    await pool.query(
      `insert into transcripts (meeting_id, user_id, speaker, ts_ms, content)
       values ($1, $2, $3, $4, $5)`,
      [meetingId, ownerId, speaker, tsMs, content],
    );
  }

  function buildApp(listLimit?: number): FastifyInstance {
    const instance = Fastify({ logger: false });
    void instance.register(
      createMeetingsRoutes({
        reader: createMeetingsReader(),
        logger: log.logger,
        now: () => NOW,
        ...(listLimit === undefined ? {} : { listLimit }),
      }),
    );
    return instance;
  }

  beforeAll(async () => {
    if (!dbUrl || !url || !serviceRoleKey) throw new Error("stack env missing");
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    admin = createClient(url, serviceRoleKey, noPersist);

    const a = await createUser("a");
    userAId = a.id;
    tokenA = a.token;
    userIds.push(userAId);
    const b = await createUser("b");
    userBId = b.id;
    userIds.push(userBId);

    log = capturingLogger();
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    for (const id of userIds) {
      // Children before parents — both hold an FK on meetings.
      await pool.query("delete from live_notes where user_id = $1", [id]);
      await pool.query("delete from transcripts where user_id = $1", [id]);
      await pool.query("delete from meetings where user_id = $1", [id]);
      await admin.auth.admin.deleteUser(id);
    }
    await pool.end();
  });

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  /** Clear A's meetings so each list case starts from a known, empty state. */
  async function resetMeetings(): Promise<void> {
    for (const id of userIds) {
      await pool.query("delete from live_notes where user_id = $1", [id]);
      await pool.query("delete from transcripts where user_id = $1", [id]);
      await pool.query("delete from meetings where user_id = $1", [id]);
    }
  }

  // --- GET /meetings ---------------------------------------------------------

  it("401s without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/meetings" });
    expect(res.statusCode).toBe(401);
  });

  it("returns an empty list (not a 404) for a user with no meetings", async () => {
    await resetMeetings();
    const res = await app.inject({
      method: "GET",
      url: "/meetings",
      headers: auth(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = meetingListResponseSchema.parse(res.json());
    expect(body.meetings).toEqual([]);
    expect(body.month_count).toBe(0);
  });

  it("projects the card fields from stored notes", async () => {
    await resetMeetings();
    const id = await newMeeting(
      userAId,
      "Northwind discovery",
      "2026-07-22T12:40:00Z",
      "2026-07-22T13:14:00Z",
    );
    await setNotes(id, notesWith("Three vendors, $40k left.", "sales", 3));
    await pool.query(
      `update meetings set follow_up = '{"tone":"warm","subject":"s","body":"b"}'::jsonb
       where id = $1`,
      [id],
    );

    const res = await app.inject({
      method: "GET",
      url: "/meetings",
      headers: auth(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = meetingListResponseSchema.parse(res.json());
    expect(body.meetings).toHaveLength(1);
    const item = body.meetings[0];
    expect(item?.id).toBe(id);
    expect(item?.title).toBe("Northwind discovery");
    expect(item?.notes_status).toBe("completed");
    expect(item?.tldr).toBe("Three vendors, $40k left.");
    expect(item?.conversation_type).toBe("sales");
    expect(item?.action_item_count).toBe(3);
    expect(item?.has_follow_up).toBe(true);
  });

  it("never ships the raw notes blob to the client", async () => {
    // The whole reason this route exists rather than a direct PostgREST read.
    await resetMeetings();
    const id = await newMeeting(userAId, "Blob check", "2026-07-22T09:00:00Z");
    await setNotes(id, notesWith("Summary.", "sales", 1));

    const res = await app.inject({
      method: "GET",
      url: "/meetings",
      headers: auth(tokenA),
    });

    // Assert the row is actually THERE first — otherwise an empty list would
    // satisfy every not-contains below and this test would pass for the wrong
    // reason, which is exactly how a leak check rots into decoration.
    const body = meetingListResponseSchema.parse(res.json());
    expect(body.meetings).toHaveLength(1);
    expect(body.meetings[0]?.tldr).toBe("Summary.");

    const raw = res.body;
    expect(raw).not.toContain("typeInsights");
    expect(raw).not.toContain("overview");
    expect(raw).not.toContain("actionItems");
    expect(raw).not.toContain("decisions");
  });

  it("falls back to the LIVE tldr while the pipeline is still running", async () => {
    await resetMeetings();
    const id = await newMeeting(userAId, "In progress", "2026-07-22T14:00:00Z");
    await pool.query(
      "update meetings set notes_status = 'processing' where id = $1",
      [id],
    );
    await setLiveNotes(
      id,
      userAId,
      notesWith("Budget discussed so far.", "sales", 2, "live"),
    );

    const res = await app.inject({
      method: "GET",
      url: "/meetings",
      headers: auth(tokenA),
    });

    const body = meetingListResponseSchema.parse(res.json());
    const item = body.meetings[0];
    expect(item?.notes_status).toBe("processing");
    expect(item?.tldr).toBe("Budget discussed so far.");
    // The deliberate asymmetry: prose falls back, settled-looking chips do not.
    expect(item?.conversation_type).toBeNull();
    expect(item?.action_item_count).toBe(0);
  });

  it("orders newest first and sorts null started_at last", async () => {
    await resetMeetings();
    const older = await newMeeting(userAId, "Older", "2026-07-20T10:00:00Z");
    const newer = await newMeeting(userAId, "Newer", "2026-07-22T10:00:00Z");
    const never = await newMeeting(userAId, "Never started", null);

    const res = await app.inject({
      method: "GET",
      url: "/meetings",
      headers: auth(tokenA),
    });

    const body = meetingListResponseSchema.parse(res.json());
    // Without `nullsFirst: false` the never-connected row would head the list
    // forever — it has no start date to age it out.
    expect(body.meetings.map((m) => m.id)).toEqual([newer, older, never]);
  });

  it("excludes soft-deleted meetings", async () => {
    await resetMeetings();
    const kept = await newMeeting(userAId, "Kept", "2026-07-22T10:00:00Z");
    const gone = await newMeeting(userAId, "Gone", "2026-07-22T11:00:00Z");
    await pool.query("update meetings set deleted_at = now() where id = $1", [
      gone,
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/meetings",
      headers: auth(tokenA),
    });

    const body = meetingListResponseSchema.parse(res.json());
    expect(body.meetings.map((m) => m.id)).toEqual([kept]);
  });

  it("never leaks another user's meetings", async () => {
    await resetMeetings();
    await newMeeting(userBId, "B's private call", "2026-07-22T10:00:00Z");
    const mine = await newMeeting(userAId, "Mine", "2026-07-22T09:00:00Z");

    const res = await app.inject({
      method: "GET",
      url: "/meetings",
      headers: auth(tokenA),
    });

    const body = meetingListResponseSchema.parse(res.json());
    expect(body.meetings.map((m) => m.id)).toEqual([mine]);
  });

  it("counts only this UTC month, and only the caller's calls", async () => {
    await resetMeetings();
    await newMeeting(userAId, "This month", "2026-07-02T10:00:00Z");
    await newMeeting(userAId, "Also this month", "2026-07-22T10:00:00Z");
    await newMeeting(userAId, "Last month", "2026-06-30T23:59:59Z");
    await newMeeting(userBId, "B, this month", "2026-07-10T10:00:00Z");

    const res = await app.inject({
      method: "GET",
      url: "/meetings",
      headers: auth(tokenA),
    });

    const body = meetingListResponseSchema.parse(res.json());
    expect(body.month_count).toBe(2);
  });

  it("caps the page and LOGS the truncation rather than hiding it", async () => {
    await resetMeetings();
    for (let i = 0; i < 3; i++) {
      await newMeeting(
        userAId,
        `Call ${String(i)}`,
        `2026-07-2${String(i)}T10:00:00Z`,
      );
    }

    // Count truncation lines emitted BY THIS CASE only — `log` is shared across
    // the suite, so a bare `.some()` would also pass on someone else's line.
    const before = log.lines.filter(
      (l) => l.msg === "meetings.list.truncated",
    ).length;

    const capped = buildApp(2);
    await capped.ready();
    try {
      const res = await capped.inject({
        method: "GET",
        url: "/meetings",
        headers: auth(tokenA),
      });

      const body = meetingListResponseSchema.parse(res.json());
      expect(body.meetings).toHaveLength(2);
      // A silently truncated list reads as "you have no older meetings".
      const after = log.lines.filter(
        (l) => l.msg === "meetings.list.truncated",
      ).length;
      expect(after).toBe(before + 1);
    } finally {
      await capped.close();
    }
  });

  it("does NOT log truncation when the page is not full", async () => {
    // The other half of the cap contract: a partial page is complete, and saying
    // "truncated" there would make the signal meaningless.
    await resetMeetings();
    await newMeeting(userAId, "Only one", "2026-07-22T10:00:00Z");
    const before = log.lines.filter(
      (l) => l.msg === "meetings.list.truncated",
    ).length;

    const capped = buildApp(2);
    await capped.ready();
    try {
      await capped.inject({
        method: "GET",
        url: "/meetings",
        headers: auth(tokenA),
      });
      const after = log.lines.filter(
        (l) => l.msg === "meetings.list.truncated",
      ).length;
      expect(after).toBe(before);
    } finally {
      await capped.close();
    }
  });

  // --- GET /meetings/:id/transcript ------------------------------------------

  it("returns turns ordered by ts_ms", async () => {
    await resetMeetings();
    const id = await newMeeting(userAId, "Call", "2026-07-22T10:00:00Z");
    await addTurn(id, userAId, "you", 11_000, "What's driving the timeline?");
    await addTurn(id, userAId, "dana", 4_000, "Thanks for making time.");
    await addTurn(id, userAId, "dana", 19_000, "Honestly, budget.");

    const res = await app.inject({
      method: "GET",
      url: `/meetings/${id}/transcript`,
      headers: auth(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = meetingTranscriptResponseSchema.parse(res.json());
    expect(body.turns.map((t) => t.ts_ms)).toEqual([4_000, 11_000, 19_000]);
    expect(body.turns[0]?.speaker).toBe("dana");
  });

  it("sorts null ts_ms last instead of ahead of every timed turn", async () => {
    await resetMeetings();
    const id = await newMeeting(userAId, "Call", "2026-07-22T10:00:00Z");
    await addTurn(id, userAId, null, null, "No timestamp.");
    await addTurn(id, userAId, "dana", 4_000, "Timed.");

    const res = await app.inject({
      method: "GET",
      url: `/meetings/${id}/transcript`,
      headers: auth(tokenA),
    });

    const body = meetingTranscriptResponseSchema.parse(res.json());
    expect(body.turns.map((t) => t.content)).toEqual([
      "Timed.",
      "No timestamp.",
    ]);
  });

  it("200s with an EMPTY array for a meeting that has not spoken", async () => {
    // The distinction the ownership pre-check exists to make. Collapsing this into
    // the 404 would hide every call that connected but produced no final turns.
    await resetMeetings();
    const id = await newMeeting(userAId, "Silent", "2026-07-22T10:00:00Z");

    const res = await app.inject({
      method: "GET",
      url: `/meetings/${id}/transcript`,
      headers: auth(tokenA),
    });

    expect(res.statusCode).toBe(200);
    expect(meetingTranscriptResponseSchema.parse(res.json()).turns).toEqual([]);
  });

  it("excludes soft-deleted turns", async () => {
    await resetMeetings();
    const id = await newMeeting(userAId, "Call", "2026-07-22T10:00:00Z");
    await addTurn(id, userAId, "dana", 1_000, "Kept.");
    await addTurn(id, userAId, "dana", 2_000, "Removed.");
    await pool.query(
      "update transcripts set deleted_at = now() where content = 'Removed.'",
    );

    const res = await app.inject({
      method: "GET",
      url: `/meetings/${id}/transcript`,
      headers: auth(tokenA),
    });

    const body = meetingTranscriptResponseSchema.parse(res.json());
    expect(body.turns.map((t) => t.content)).toEqual(["Kept."]);
  });

  it("404s identically for unknown, foreign, and soft-deleted meetings", async () => {
    await resetMeetings();
    const foreign = await newMeeting(userBId, "B's", "2026-07-22T10:00:00Z");
    await addTurn(foreign, userBId, "b", 1_000, "Private.");
    const deleted = await newMeeting(userAId, "Gone", "2026-07-22T10:00:00Z");
    await pool.query("update meetings set deleted_at = now() where id = $1", [
      deleted,
    ]);

    const targets = [randomUUID(), foreign, deleted];
    for (const target of targets) {
      const res = await app.inject({
        method: "GET",
        url: `/meetings/${target}/transcript`,
        headers: auth(tokenA),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not_found" });
    }
  });

  it("404s (never 400s) on a non-uuid id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/meetings/not-a-uuid/transcript",
      headers: auth(tokenA),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("401s the transcript route without a token", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/meetings/${randomUUID()}/transcript`,
    });
    expect(res.statusCode).toBe(401);
  });
});
