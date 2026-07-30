import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  followUpDraftSchema,
  identifyNotes,
  notesReadResponseSchema,
  type MeetingNotes,
} from "@nova/shared";

import { createNotesJobStore, type NotesJobStore } from "../../db/jobs.js";
import {
  createLiveNotesStore,
  type LiveNotesStore,
} from "../../db/live-notes.js";
import { createFollowUpWriter, createNotesReader } from "../../db/notes.js";
import type { LlmRouter, LlmStreamEvent } from "../llm/index.js";
import { LlmError } from "../llm/index.js";

import { generateFollowUp } from "./follow-up.js";
import type { NotesLogger } from "./ports.js";
import { createNotesRoutes } from "./routes.js";

/**
 * Route integration suite (playbook VERIFY) — REAL local Supabase Postgres for the
 * read/write/store seams + REAL Supabase-issued JWTs through `requireAuth`, with a
 * MOCK llm router for the synchronous follow-up call (no vendor key). Proves the full
 * authed REST contract: happy reads, 401 unauthed, the uniform 404 trio
 * (missing/foreign/soft-deleted), the 409s (already_running, notes_not_ready), a zod
 * 400 on a bad tone, a provider-down 503, and follow_up persisted + returned on a
 * later GET. Self-skips unless the stack env is present so `npm run test` stays green.
 */

const dbUrl = process.env.SUPABASE_DB_URL;
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const hasStack = Boolean(dbUrl && url && serviceRoleKey && anonKey);

const noPersist = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

/** A valid notes object stored to force `notes_status='completed'` for follow-up. */
const COMPLETED_NOTES: MeetingNotes = identifyNotes(
  {
    conversationType: "sales",
    title: "Renewal call",
    tldr: "Agreed to renew on the Growth plan next quarter.",
    overview:
      "The rep and customer reviewed terms and aligned on the renewal path.",
    decisions: [{ text: "Renew on the Growth plan.", quote: null }],
    actionItems: [
      {
        text: "Send the renewal paperwork.",
        owner: "Rep",
        deadline: null,
        deadlineRaw: null,
        quote: null,
      },
    ],
    openQuestions: [],
    risks: [],
    typeInsights: { kind: "sales", objections: [], buyingSignals: [] },
  },
  "generated",
);

/** A mock router that streams a fixed body for the follow-up generate call. */
function replyRouter(bodyJson: string): LlmRouter {
  return {
    async *stream(): AsyncGenerator<LlmStreamEvent> {
      await Promise.resolve();
      yield { type: "token", text: bodyJson };
      yield { type: "done", usage: { inputTokens: 20, outputTokens: 9 } };
    },
  };
}

/** A mock router that throws a transport failure (drives the 503 path). */
function throwingRouter(): LlmRouter {
  return {
    // eslint-disable-next-line require-yield -- why: this fake exists to throw before any yield, driving the 503 transport-failure path.
    async *stream(): AsyncGenerator<LlmStreamEvent> {
      await Promise.resolve();
      throw LlmError.transient("provider down");
    },
  };
}

const OK_FOLLOW_UP_BODY = JSON.stringify({
  subject: "Renewal — next steps",
  body: "Hi,\n\nThanks for the call. As agreed we'll renew on Growth.\n\nBest",
});

/** A NotesLogger that records the structured fields it was handed. */
interface CapturedLog {
  fields: Record<string, unknown>;
  msg: string;
}
function capturingLogger(): { logger: NotesLogger; lines: CapturedLog[] } {
  const lines: CapturedLog[] = [];
  return {
    lines,
    logger: {
      info: (fields, msg) => lines.push({ fields, msg }),
      error: (fields, msg) => lines.push({ fields, msg }),
    },
  };
}

describe.skipIf(!hasStack)("notes REST routes (local stack)", () => {
  let pool: Pool;
  let admin: ReturnType<typeof createClient>;
  let store: NotesJobStore;
  let liveNotesStore: LiveNotesStore;
  let okApp: FastifyInstance;
  let downApp: FastifyInstance;
  let okLog: { logger: NotesLogger; lines: CapturedLog[] };

  let tokenA: string;
  let userAId: string;
  let tokenB: string;
  let userBId: string;
  const userIds: string[] = [];

  async function createUser(
    label: string,
  ): Promise<{ id: string; token: string }> {
    if (!url || !anonKey) throw new Error("stack env missing");
    const email = `routes-${label}-${randomUUID()}@nova.test`;
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

  async function newMeeting(ownerId: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `insert into meetings (user_id, title, started_at, ended_at, notes_status)
       values ($1, $2, now(), now(), 'none') returning id`,
      [ownerId, "Renewal call"],
    );
    const id = r.rows[0]?.id;
    if (id === undefined) throw new Error("meeting insert returned no id");
    return id;
  }

  /** Force a meeting into the completed-notes state (for the follow-up happy path). */
  async function completeNotes(meetingId: string): Promise<void> {
    await pool.query(
      `update meetings set notes = $2::jsonb, notes_status = 'completed',
         notes_generated_at = now() where id = $1`,
      [meetingId, JSON.stringify(COMPLETED_NOTES)],
    );
  }

  function buildApp(
    followUpRouter: LlmRouter,
    log: NotesLogger,
    isOverLlmQuota?: (userId: string) => Promise<boolean>,
    isDailyCapReached?: () => Promise<boolean>,
    /** Omitted to exercise the DB-less posture (`live_notes` must read null). */
    liveNotes?: LiveNotesStore,
  ): FastifyInstance {
    const app = Fastify({ logger: false });
    void app.register(
      createNotesRoutes({
        reader: createNotesReader(),
        followUpWriter: createFollowUpWriter(),
        store,
        followUp: generateFollowUp({ router: followUpRouter, logger: log }),
        logger: log,
        now: () => new Date("2026-07-22T18:00:00Z"),
        ...(isOverLlmQuota ? { isOverLlmQuota } : {}),
        ...(isDailyCapReached ? { isDailyCapReached } : {}),
        ...(liveNotes ? { liveNotes } : {}),
      }),
    );
    return app;
  }

  beforeAll(async () => {
    if (!dbUrl || !url || !serviceRoleKey) throw new Error("stack env missing");
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    admin = createClient(url, serviceRoleKey, noPersist);
    store = createNotesJobStore(pool);

    const a = await createUser("a");
    userAId = a.id;
    tokenA = a.token;
    userIds.push(userAId);
    const b = await createUser("b");
    userBId = b.id;
    tokenB = b.token;
    userIds.push(userBId);

    okLog = capturingLogger();
    liveNotesStore = createLiveNotesStore(pool);
    okApp = buildApp(
      replyRouter(OK_FOLLOW_UP_BODY),
      okLog.logger,
      undefined,
      undefined,
      liveNotesStore,
    );
    downApp = buildApp(throwingRouter(), capturingLogger().logger);
    await okApp.ready();
    await downApp.ready();
  });

  afterAll(async () => {
    await okApp.close();
    await downApp.close();
    for (const id of userIds) {
      await pool.query("delete from jobs where user_id = $1", [id]);
      // live_notes before meetings — it holds the FK.
      await pool.query("delete from live_notes where user_id = $1", [id]);
      await pool.query("delete from meetings where user_id = $1", [id]);
      await admin.auth.admin.deleteUser(id);
    }
    await pool.end();
  });

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  // --- GET /meetings/:id/notes ------------------------------------------------

  it("GET returns the read model for the owner (200)", async () => {
    const meetingId = await newMeeting(userAId);
    const res = await okApp.inject({
      method: "GET",
      url: `/meetings/${meetingId}/notes`,
      headers: auth(tokenA),
    });
    expect(res.statusCode).toBe(200);
    const body = notesReadResponseSchema.parse(res.json());
    expect(body.notes_status).toBe("none");
    expect(body.notes).toBeNull();
    expect(body.follow_up).toBeNull();
    // No fold has run for this meeting — the preview is absent, not an error.
    expect(body.live_notes).toBeNull();
    expect(body.live_notes_rev).toBeNull();
  });

  it("GET surfaces the live-notes preview and its rev (Phase 8 §7)", async () => {
    const meetingId = await newMeeting(userAId);
    const preview: MeetingNotes = { ...COMPLETED_NOTES, source: "live" };
    await liveNotesStore.upsertLiveNotes({
      meetingId,
      userId: userAId,
      notes: preview,
      rev: 6,
    });

    const res = await okApp.inject({
      method: "GET",
      url: `/meetings/${meetingId}/notes`,
      headers: auth(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = notesReadResponseSchema.parse(res.json());
    expect(body.live_notes).toEqual(preview);
    expect(body.live_notes_rev).toBe(6);
    // `notes_status` semantics are UNTOUCHED by the preview — the tab's retry
    // affordance still keys off it, and a preview is not a completed generation.
    expect(body.notes_status).toBe("none");
    expect(body.notes).toBeNull();
  });

  it("GET reads live_notes as null when the store is unwired (DB-less posture)", async () => {
    // `downApp` is built without a liveNotes store: the field must degrade to
    // null, never throw and never 500.
    const meetingId = await newMeeting(userAId);
    await liveNotesStore.upsertLiveNotes({
      meetingId,
      userId: userAId,
      notes: { ...COMPLETED_NOTES, source: "live" },
      rev: 1,
    });

    const res = await downApp.inject({
      method: "GET",
      url: `/meetings/${meetingId}/notes`,
      headers: auth(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = notesReadResponseSchema.parse(res.json());
    expect(body.live_notes).toBeNull();
    expect(body.live_notes_rev).toBeNull();
  });

  it("GET degrades live_notes to null when the store THROWS (best-effort)", async () => {
    // The unwired case above already degrades to null and the pipeline's sibling
    // read (handler.ts readLivePreview) catches. A WIRED store that fails must
    // reach the same place: the primary notes payload is the contract and the
    // live preview is a cosmetic add-on, so a live_notes outage must not turn a
    // perfectly good read into a 500.
    const meetingId = await newMeeting(userAId);
    const brokenLog = capturingLogger();
    const brokenApp = buildApp(
      replyRouter(OK_FOLLOW_UP_BODY),
      brokenLog.logger,
      undefined,
      undefined,
      {
        readLiveNotes: () =>
          Promise.reject(new Error("live_notes read failed")),
        upsertLiveNotes: () =>
          Promise.reject(new Error("not exercised by this test")),
      },
    );

    try {
      const res = await brokenApp.inject({
        method: "GET",
        url: `/meetings/${meetingId}/notes`,
        headers: auth(tokenA),
      });

      expect(res.statusCode).toBe(200);
      const body = notesReadResponseSchema.parse(res.json());
      expect(body.live_notes).toBeNull();
      expect(body.live_notes_rev).toBeNull();
      // Degrading silently would hide a real outage — it must be logged.
      expect(brokenLog.lines.map((l) => l.msg)).toContain(
        "notes.routes.live_notes_read_failed",
      );
    } finally {
      await brokenApp.close();
    }
  });

  it("GET does not leak another user's live-notes preview", async () => {
    // The store is user-scoped in SQL as well as behind the ownership gate.
    const meetingId = await newMeeting(userAId);
    await liveNotesStore.upsertLiveNotes({
      meetingId,
      userId: userAId,
      notes: { ...COMPLETED_NOTES, source: "live" },
      rev: 2,
    });

    const res = await okApp.inject({
      method: "GET",
      url: `/meetings/${meetingId}/notes`,
      headers: auth(tokenB),
    });

    // The ownership gate fires first: a uniform 404, no preview, no existence leak.
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("GET a meeting whose stored notes are v1 still returns 200 (the read boundary)", async () => {
    // The regression this guards: `meetingNotesSchema` is `version: z.literal(2)`,
    // so parsing a pre-split row with it throws and turns this endpoint into a
    // permanent 500. `storedNotesSchema` accepts v1 ∪ v2 and upcasts in code —
    // no backfill migration (docs/DESIGN/live-notes.md §2).
    const meetingId = await newMeeting(userAId);
    const storedV1 = {
      version: 1,
      conversationType: "sales",
      title: "Legacy call",
      tldr: "Stored before the v2 split.",
      overview: "A row that predates identified note ids.",
      decisions: [{ text: "Renew on Growth", quote: null }],
      actionItems: [
        {
          text: "Send the contract",
          owner: null,
          deadline: null,
          deadlineRaw: null,
          quote: null,
        },
      ],
      openQuestions: ["What is the seat count?"],
      risks: ["Budget freeze"],
      typeInsights: { kind: "sales", objections: [], buyingSignals: [] },
      source: "generated",
    };
    await pool.query(
      `update meetings set notes = $2::jsonb, notes_status = 'completed',
         notes_generated_at = now() where id = $1`,
      [meetingId, JSON.stringify(storedV1)],
    );

    const res = await okApp.inject({
      method: "GET",
      url: `/meetings/${meetingId}/notes`,
      headers: auth(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = notesReadResponseSchema.parse(res.json());
    // Upcast on the way out: v2, with ids minted by array index.
    expect(body.notes?.version).toBe(2);
    expect(body.notes?.title).toBe("Legacy call");
    expect(body.notes?.decisions[0]?.id).toBe("d1");
    expect(body.notes?.openQuestions[0]).toEqual({
      id: "q1",
      text: "What is the seat count?",
    });
  });

  it("GET without a token is 401 (unauthed)", async () => {
    const meetingId = await newMeeting(userAId);
    const res = await okApp.inject({
      method: "GET",
      url: `/meetings/${meetingId}/notes`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET a missing meeting is a uniform 404", async () => {
    const res = await okApp.inject({
      method: "GET",
      url: `/meetings/${randomUUID()}/notes`,
      headers: auth(tokenA),
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET a foreign meeting is a uniform 404 (no existence leak)", async () => {
    const meetingId = await newMeeting(userAId);
    const res = await okApp.inject({
      method: "GET",
      url: `/meetings/${meetingId}/notes`,
      headers: auth(tokenB),
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET a soft-deleted meeting is a uniform 404", async () => {
    const meetingId = await newMeeting(userAId);
    await pool.query("update meetings set deleted_at = now() where id = $1", [
      meetingId,
    ]);
    const res = await okApp.inject({
      method: "GET",
      url: `/meetings/${meetingId}/notes`,
      headers: auth(tokenA),
    });
    expect(res.statusCode).toBe(404);
  });

  // --- POST /meetings/:id/notes/regenerate ------------------------------------

  it("regenerate enqueues (202 queued) then 409 already_running while active", async () => {
    const meetingId = await newMeeting(userAId);

    const first = await okApp.inject({
      method: "POST",
      url: `/meetings/${meetingId}/notes/regenerate`,
      headers: auth(tokenA),
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ status: "queued" });

    // The store flipped the read model to 'queued' and created an active job.
    const row = await pool.query<{ notes_status: string }>(
      "select notes_status from meetings where id = $1",
      [meetingId],
    );
    expect(row.rows[0]?.notes_status).toBe("queued");

    const second = await okApp.inject({
      method: "POST",
      url: `/meetings/${meetingId}/notes/regenerate`,
      headers: auth(tokenA),
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "already_running" });
  });

  it("regenerate on a foreign meeting is a uniform 404", async () => {
    const meetingId = await newMeeting(userAId);
    const res = await okApp.inject({
      method: "POST",
      url: `/meetings/${meetingId}/notes/regenerate`,
      headers: auth(tokenB),
    });
    expect(res.statusCode).toBe(404);
  });

  // --- POST /meetings/:id/follow-up -------------------------------------------

  it("follow-up is 409 notes_not_ready when notes are not completed", async () => {
    const meetingId = await newMeeting(userAId);
    const res = await okApp.inject({
      method: "POST",
      url: `/meetings/${meetingId}/follow-up`,
      headers: auth(tokenA),
      payload: { tone: "professional" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "notes_not_ready" });
  });

  it("follow-up rejects a bad tone with a zod 400", async () => {
    const meetingId = await newMeeting(userAId);
    await completeNotes(meetingId);
    const res = await okApp.inject({
      method: "POST",
      url: `/meetings/${meetingId}/follow-up`,
      headers: auth(tokenA),
      payload: { tone: "sarcastic" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("follow-up returns the draft, persists it, and logs a per-user usage line (Phase 6 metering seam)", async () => {
    const meetingId = await newMeeting(userAId);
    await completeNotes(meetingId);

    const res = await okApp.inject({
      method: "POST",
      url: `/meetings/${meetingId}/follow-up`,
      headers: auth(tokenA),
      payload: { tone: "professional" },
    });
    expect(res.statusCode).toBe(200);
    const draft = followUpDraftSchema.parse(res.json());
    expect(draft.tone).toBe("professional");
    expect(draft.subject).toBe("Renewal — next steps");

    // Persisted to meetings.follow_up and returned on a subsequent GET.
    const get = await okApp.inject({
      method: "GET",
      url: `/meetings/${meetingId}/notes`,
      headers: auth(tokenA),
    });
    const body = notesReadResponseSchema.parse(get.json());
    expect(body.follow_up?.subject).toBe("Renewal — next steps");
    expect(body.follow_up?.tone).toBe("professional");
    expect(body.follow_up?.generated_at).toBe("2026-07-22T18:00:00.000Z");

    // The per-user follow-up usage line landed (ids + counts only).
    const usageLine = okLog.lines.find(
      (l) => l.msg === "notes.follow_up.usage",
    );
    expect(usageLine).toBeDefined();
    expect(usageLine?.fields.user_id).toBe(userAId);
    expect(usageLine?.fields.meeting_id).toBe(meetingId);
    expect(usageLine?.fields.input_tokens).toBe(20);
    expect(usageLine?.fields.calls).toBe(1);
  });

  it("follow-up maps a transport failure to a typed 503 (no stack leak)", async () => {
    const meetingId = await newMeeting(userAId);
    await completeNotes(meetingId);

    const res = await downApp.inject({
      method: "POST",
      url: `/meetings/${meetingId}/follow-up`,
      headers: auth(tokenA),
      payload: { tone: "warm" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "provider_unavailable" });
  });

  it("follow-up over the llm quota is a typed 429 quota_exceeded (paywall; no call made)", async () => {
    const meetingId = await newMeeting(userAId);
    await completeNotes(meetingId);

    // A router that would blow up if the quota gate let the call through.
    const quotaApp = buildApp(throwingRouter(), okLog.logger, (userId) => {
      expect(userId).toBe(userAId);
      return Promise.resolve(true);
    });
    const res = await quotaApp.inject({
      method: "POST",
      url: `/meetings/${meetingId}/follow-up`,
      headers: auth(tokenA),
      payload: { tone: "warm" },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: "quota_exceeded" });
  });

  it("follow-up under a tripped daily cap is a typed 503 daily_cap_reached (no call made)", async () => {
    const meetingId = await newMeeting(userAId);
    await completeNotes(meetingId);

    // A router that would blow up if the cap gate let the call through.
    const capApp = buildApp(throwingRouter(), okLog.logger, undefined, () =>
      Promise.resolve(true),
    );
    const res = await capApp.inject({
      method: "POST",
      url: `/meetings/${meetingId}/follow-up`,
      headers: auth(tokenA),
      payload: { tone: "warm" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "daily_cap_reached" });
  });

  it("follow-up on a foreign meeting is a uniform 404", async () => {
    const meetingId = await newMeeting(userAId);
    await completeNotes(meetingId);
    const res = await okApp.inject({
      method: "POST",
      url: `/meetings/${meetingId}/follow-up`,
      headers: auth(tokenB),
      payload: { tone: "brief" },
    });
    expect(res.statusCode).toBe(404);
  });
});
