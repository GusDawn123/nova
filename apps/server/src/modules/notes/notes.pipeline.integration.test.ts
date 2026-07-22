import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { meetingNotesSchema } from "@nova/shared";

import { createNotesJobStore, type ClaimedJob, type NotesJobStore } from "../../db/jobs.js";
import { createNotesSource } from "../../db/notes-source.js";
import { createNotesWriter } from "../../db/notes.js";
import { createTranscriptPersister } from "../../db/transcripts.js";

import { createNotesJobHandler } from "./handler.js";
import { createNotesPipeline } from "./pipeline.js";
import type { NotesJobHandler, NotesLogger, NotesWorker } from "./ports.js";
import { createNotesWorker } from "./worker.js";
import { makeNotesRouter } from "./testing/mock-notes-router.js";

/**
 * Full-loop proof (playbook VERIFY) against the LIVE local Supabase Postgres with a
 * MOCK llm router (no vendor key). Drives the REAL machinery end to end:
 *
 *   seed user + meeting + transcripts
 *     → markEnded (real persister, real onEnded eager-enqueue → real store)
 *     → worker.tickOnce (real handler: real source → real pipeline/mock router →
 *        real writer)
 *     → meetings.notes zod-valid + notes_status='completed' + notes_generated_at set
 *        + jobs row 'completed' with usage jsonb populated
 *   then: re-run the handler → idempotent (one meeting row, still completed)
 *   then: enqueue a regenerate-shaped job after completion → allowed (history kept).
 *
 * Self-skips unless SUPABASE_DB_URL + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are
 * all present (so `npm run test` stays green with the stack down). Files run
 * sequentially (root vitest `fileParallelism:false`), so the GLOBAL atomic claim is
 * deterministic; the one job we enqueue is backdated to be the oldest eligible row.
 */

const dbUrl = process.env.SUPABASE_DB_URL;
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasStack = Boolean(dbUrl && url && serviceRoleKey);

const noPersist = { auth: { persistSession: false, autoRefreshToken: false } } as const;
const NOOP_LOGGER: NotesLogger = { info: () => {}, error: () => {} };

/** A schema-valid single-pass sales notes object the mock generate call returns. */
const SALES_NOTES = {
  conversationType: "sales",
  title: "Renewal call",
  tldr: "Discussed the renewal and agreed on next steps.",
  overview: "The rep and the customer reviewed the renewal terms and aligned on the path forward.",
  decisions: [],
  actionItems: [],
  openQuestions: [],
  risks: [],
  typeInsights: { kind: "sales", objections: [], buyingSignals: [] },
};

describe.skipIf(!hasStack)("notes pipeline full loop (local stack)", () => {
  let pool: Pool;
  let admin: ReturnType<typeof createClient>;
  let store: NotesJobStore;
  let handler: NotesJobHandler;
  let worker: NotesWorker;
  let userId: string;
  let enqueuePromise: Promise<unknown> = Promise.resolve();
  const userIds: string[] = [];

  const persister = () =>
    createTranscriptPersister({
      onEnded: (meetingId, uid) => {
        // The eager best-effort enqueue seam (adr §4), wired to the REAL store.
        enqueuePromise = store.enqueue(meetingId, uid);
      },
    });

  async function newMeeting(): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `insert into meetings (user_id, title, started_at, ended_at, notes_status)
       values ($1, $2, now(), null, 'none') returning id`,
      [userId, "Renewal call"],
    );
    const id = r.rows[0]?.id;
    if (id === undefined) throw new Error("meeting insert returned no id");
    return id;
  }

  async function seedTranscripts(meetingId: string): Promise<void> {
    const lines = [
      ["Rep", "Thanks for making time to talk about the renewal."],
      ["Customer", "Happy to. We are mostly satisfied with the platform."],
      ["Rep", "Great. Let me walk through the updated terms."],
    ] as const;
    let ts = 0;
    for (const [speaker, content] of lines) {
      await pool.query(
        "insert into transcripts (meeting_id, user_id, content, speaker, ts_ms) values ($1,$2,$3,$4,$5)",
        [meetingId, userId, content, speaker, ts],
      );
      ts += 4000;
    }
  }

  async function activeJobId(meetingId: string): Promise<string | null> {
    const r = await pool.query<{ id: string }>(
      `select id from jobs where meeting_id = $1 and status in ('queued','processing') limit 1`,
      [meetingId],
    );
    return r.rows[0]?.id ?? null;
  }

  async function jobRow(
    id: string,
  ): Promise<{ status: string; usage: unknown } | null> {
    const r = await pool.query<{ status: string; usage: unknown }>(
      "select status, usage from jobs where id = $1",
      [id],
    );
    return r.rows[0] ?? null;
  }

  async function meetingNotesRow(meetingId: string): Promise<{
    notes: unknown;
    notes_status: string;
    notes_generated_at: string | null;
  }> {
    const r = await pool.query<{
      notes: unknown;
      notes_status: string;
      notes_generated_at: string | null;
    }>(
      "select notes, notes_status, notes_generated_at from meetings where id = $1",
      [meetingId],
    );
    const row = r.rows[0];
    if (row === undefined) throw new Error(`no meeting ${meetingId}`);
    return row;
  }

  async function jobCountForMeeting(meetingId: string): Promise<number> {
    const r = await pool.query<{ n: number }>(
      "select count(*)::int as n from jobs where meeting_id = $1",
      [meetingId],
    );
    return r.rows[0]?.n ?? 0;
  }

  beforeAll(async () => {
    if (!dbUrl || !url || !serviceRoleKey) throw new Error("stack env missing");
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    admin = createClient(url, serviceRoleKey, noPersist);
    const created = await admin.auth.admin.createUser({
      email: `notes-loop-${randomUUID()}@nova.test`,
      password: `Pw-${randomUUID()}`,
      email_confirm: true,
    });
    if (created.error) throw new Error(`createUser: ${created.error.message}`);
    userId = created.data.user.id;
    userIds.push(userId);

    store = createNotesJobStore(pool);
    const router = makeNotesRouter({ generate: () => SALES_NOTES });
    const pipeline = createNotesPipeline({ router, logger: NOOP_LOGGER });
    handler = createNotesJobHandler({
      pipeline,
      source: createNotesSource(),
      writer: createNotesWriter(),
      logger: NOOP_LOGGER,
    });
    worker = createNotesWorker({ store, handler, logger: NOOP_LOGGER });
  });

  afterAll(async () => {
    for (const id of userIds) {
      await pool.query("delete from jobs where user_id = $1", [id]);
      await pool.query("delete from transcripts where user_id = $1", [id]);
      await pool.query("delete from meetings where user_id = $1", [id]);
      await admin.auth.admin.deleteUser(id);
    }
    await pool.end();
  });

  let meetingId: string;

  it("markEnded → eager enqueue → tickOnce writes valid notes + completes the job", async () => {
    meetingId = await newMeeting();
    await seedTranscripts(meetingId);

    // Real disposal: stamp ended_at, which fires the real onEnded enqueue hook.
    await persister().markEnded(meetingId, userId);
    await enqueuePromise;

    expect(await meetingNotesRow(meetingId).then((r) => r.notes_status)).toBe("queued");
    const jobId = await activeJobId(meetingId);
    expect(jobId).not.toBeNull();
    // Make my job the oldest eligible row so the global claim picks it deterministically.
    await pool.query("update jobs set run_at = now() - interval '1 day' where id = $1", [jobId]);

    const processed = await worker.tickOnce();
    expect(processed).toBe(1);

    const row = await meetingNotesRow(meetingId);
    expect(row.notes_status).toBe("completed");
    expect(row.notes_generated_at).not.toBeNull();
    expect(() => meetingNotesSchema.parse(row.notes)).not.toThrow();

    // The job row is completed with a populated usage jsonb (classify + generate).
    const job = jobId !== null ? await jobRow(jobId) : null;
    expect(job?.status).toBe("completed");
    expect(Array.isArray(job?.usage)).toBe(true);
    expect((job?.usage as unknown[]).length).toBeGreaterThan(0);
  });

  it("re-running the handler is idempotent (one meeting row, still completed)", async () => {
    // A fresh ClaimedJob for the same meeting — the handler's write is an idempotent
    // user-scoped upsert, so a second run overwrites identically.
    const rerun: ClaimedJob = {
      id: randomUUID(),
      kind: "generate_notes",
      meetingId,
      userId,
      attempts: 1,
      maxAttempts: 5,
    };
    const outcome = await handler.handle(rerun);
    expect(outcome.outcome).toBe("completed");

    const rows = await pool.query<{ n: number }>(
      "select count(*)::int as n from meetings where id = $1",
      [meetingId],
    );
    expect(rows.rows[0]?.n).toBe(1); // no duplicate meeting rows
    const row = await meetingNotesRow(meetingId);
    expect(row.notes_status).toBe("completed");
    expect(() => meetingNotesSchema.parse(row.notes)).not.toThrow();
  });

  it("a regenerate-shaped job enqueues after completion (history preserved)", async () => {
    // The partial unique index only blocks a SECOND active job; a completed job is
    // history, so a fresh enqueue is allowed.
    expect(await store.enqueue(meetingId, userId)).toBe("enqueued");
    expect(await meetingNotesRow(meetingId).then((r) => r.notes_status)).toBe("queued");

    // Exactly one active job again; a further enqueue collides (already_active).
    expect(await store.enqueue(meetingId, userId)).toBe("already_active");

    // Both the completed original and the new queued row are on the books.
    expect(await jobCountForMeeting(meetingId)).toBeGreaterThanOrEqual(2);
  });
});
