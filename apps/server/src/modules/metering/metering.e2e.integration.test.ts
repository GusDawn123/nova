import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  identifyNotes,
  meetingNotesSchema,
  type NotesContent,
} from "@nova/shared";

import { createUsageEventsDb } from "../../db/usage-events.js";
import { createNotesSource } from "../../db/notes-source.js";
import { createNotesWriter } from "../../db/notes.js";
import {
  createLlmRouter,
  llmConfigSchema,
  makeMockProvider,
} from "../llm/index.js";
import { createNotesJobStore } from "../../db/jobs.js";
import { createNotesJobHandler } from "../notes/handler.js";
import { createNotesPipeline } from "../notes/pipeline.js";
import { createNotesWorker } from "../notes/worker.js";
import type { NotesLogger, NotesPipeline } from "../notes/ports.js";

import { createKillSwitch } from "./kill-switch.js";
import { createMeteringService } from "./service.js";
import type { MeteringLogger } from "./ports.js";

/**
 * E2E metering accuracy, part 1 (playbook VERIFY "Metering ±5%" — llm half): a
 * notes job driven through the REAL machinery — real failover router over a mock
 * provider with KNOWN vendor-reported usage, real pipeline with `meterFor`, real
 * handler, real supabase-js read/write seams, real `UsageEventsDb` over the live
 * local Postgres — must land `usage_events` llm_tokens rows whose amounts are
 * EXACT (vendor-reported passthrough, not an estimate) and attributed to the
 * right user + meeting. Self-skips unless the stack env is present.
 */

const dbUrl = process.env.SUPABASE_DB_URL;
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasStack = Boolean(dbUrl && url && serviceRoleKey);

const NOOP_NOTES_LOGGER: NotesLogger = { info: () => {}, error: () => {} };
const NOOP_METERING_LOGGER: MeteringLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Known vendor-reported usage: classify then generate (scripts consumed in order). */
const CLASSIFY_USAGE = { inputTokens: 111, outputTokens: 7 };
const GENERATE_USAGE = { inputTokens: 2222, outputTokens: 333 };

/** A schema-valid single-pass sales notes object the mock generate call returns. */
const SALES_NOTES: NotesContent = {
  conversationType: "sales",
  title: "Renewal call",
  tldr: "Discussed the renewal and agreed on next steps.",
  overview:
    "The rep and the customer reviewed the renewal terms and aligned on the path forward.",
  decisions: [],
  actionItems: [],
  openQuestions: [],
  risks: [],
  typeInsights: { kind: "sales", objections: [], buyingSignals: [] },
};

// Parsed through the shared schema so the cap-e2e handler returns typed notes.
const SALES_NOTES_PARSED = meetingNotesSchema.parse(identifyNotes(SALES_NOTES, "generated"));

interface UsageRow {
  vendor: string;
  kind: string;
  amount: string;
  input_amount: string | null;
  output_amount: string | null;
  meeting_id: string | null;
  user_id: string;
}

describe.skipIf(!hasStack)(
  "metering E2E accuracy — notes job (local stack)",
  () => {
    let pool: Pool;
    let admin: ReturnType<typeof createClient>;
    let userId: string;
    let meetingId: string;

    beforeAll(async () => {
      if (!dbUrl || !url || !serviceRoleKey)
        throw new Error("stack env missing");
      pool = new Pool({ connectionString: dbUrl, max: 4 });
      admin = createClient(url, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const created = await admin.auth.admin.createUser({
        email: `metering-e2e-${randomUUID()}@nova.test`,
        password: `Pw-${randomUUID()}`,
        email_confirm: true,
      });
      if (created.error)
        throw new Error(`createUser: ${created.error.message}`);
      userId = created.data.user.id;

      const meeting = await pool.query<{ id: string }>(
        `insert into meetings (user_id, title, started_at) values ($1, $2, now()) returning id`,
        [userId, "Renewal call"],
      );
      const id = meeting.rows[0]?.id;
      if (id === undefined) throw new Error("meeting insert returned no id");
      meetingId = id;

      let ts = 0;
      for (const [speaker, content] of [
        ["Rep", "Thanks for making time to talk about the renewal."],
        ["Customer", "Happy to. We are mostly satisfied with the platform."],
      ] as const) {
        await pool.query(
          "insert into transcripts (meeting_id, user_id, content, speaker, ts_ms) values ($1,$2,$3,$4,$5)",
          [meetingId, userId, content, speaker, ts],
        );
        ts += 4000;
      }
    });

    afterAll(async () => {
      await pool.query("delete from usage_events where user_id = $1", [userId]);
      await pool.query("delete from jobs where user_id = $1", [userId]);
      await pool.query("delete from transcripts where user_id = $1", [userId]);
      await pool.query("delete from meetings where user_id = $1", [userId]);
      await admin.auth.admin.deleteUser(userId);
      await pool.end();
    });

    it("[metering-e2e] a handled job lands EXACT vendor-reported llm_tokens rows, attributed", async () => {
      const metering = createMeteringService({
        db: createUsageEventsDb(pool),
        logger: NOOP_METERING_LOGGER,
      });

      // Real router over a scripted provider: call 1 = classify, call 2 = generate.
      const provider = makeMockProvider("openai", [
        {
          events: [
            { type: "token", text: "sales" },
            { type: "done", usage: CLASSIFY_USAGE },
          ],
        },
        {
          events: [
            { type: "token", text: JSON.stringify(SALES_NOTES) },
            { type: "done", usage: GENERATE_USAGE },
          ],
        },
      ]);
      const router = createLlmRouter({
        providers: [provider],
        config: llmConfigSchema.parse({}),
      });
      const pipeline = createNotesPipeline({
        router,
        logger: NOOP_NOTES_LOGGER,
        meterFor: (uid, mid) => metering.meterFor(uid, mid),
      });
      const handler = createNotesJobHandler({
        pipeline,
        source: createNotesSource(),
        writer: createNotesWriter(),
        logger: NOOP_NOTES_LOGGER,
      });

      const outcome = await handler.handle({
        id: randomUUID(),
        kind: "generate_notes",
        meetingId,
        userId,
        attempts: 1,
        maxAttempts: 5,
      });
      expect(outcome.outcome).toBe("completed");

      // The meter is fire-and-forget — poll the ledger until both rows land.
      await vi.waitFor(
        async () => {
          const r = await pool.query<UsageRow>(
            `select vendor, kind, amount, input_amount, output_amount, meeting_id, user_id
           from usage_events where user_id = $1 order by amount asc`,
            [userId],
          );
          expect(r.rowCount).toBe(2);
        },
        { timeout: 5_000 },
      );

      const rows = await pool.query<UsageRow>(
        `select vendor, kind, amount, input_amount, output_amount, meeting_id, user_id
       from usage_events where user_id = $1 order by amount asc`,
        [userId],
      );

      // EXACT vendor-reported passthrough (the accuracy bar is exact for llm), with
      // full user + meeting attribution on every row.
      const [classifyRow, generateRow] = rows.rows;
      expect(classifyRow).toBeDefined();
      expect(generateRow).toBeDefined();
      for (const row of rows.rows) {
        expect(row.vendor).toBe("openai");
        expect(row.kind).toBe("llm_tokens");
        expect(row.user_id).toBe(userId);
        expect(row.meeting_id).toBe(meetingId);
      }
      expect(Number(classifyRow?.amount)).toBe(
        CLASSIFY_USAGE.inputTokens + CLASSIFY_USAGE.outputTokens,
      );
      expect(Number(classifyRow?.input_amount)).toBe(
        CLASSIFY_USAGE.inputTokens,
      );
      expect(Number(classifyRow?.output_amount)).toBe(
        CLASSIFY_USAGE.outputTokens,
      );
      expect(Number(generateRow?.amount)).toBe(
        GENERATE_USAGE.inputTokens + GENERATE_USAGE.outputTokens,
      );
      expect(Number(generateRow?.input_amount)).toBe(
        GENERATE_USAGE.inputTokens,
      );
      expect(Number(generateRow?.output_amount)).toBe(
        GENERATE_USAGE.outputTokens,
      );

      // And the aggregate the quota engine will read is exact too.
      const used = await metering.usedInPeriod(userId, "llm_tokens");
      expect(used).toBe(118 + 2555);
    });

    it("[quota-e2e] an over-quota claim dead-letters: dead + quota_exceeded + notes_status failed", async () => {
      // A fresh ended meeting with its own queued job (the claim path, for real).
      const meeting = await pool.query<{ id: string }>(
        `insert into meetings (user_id, title, started_at, ended_at)
         values ($1, $2, now(), now()) returning id`,
        [userId, "Over-quota call"],
      );
      const quotaMeetingId = meeting.rows[0]?.id;
      if (quotaMeetingId === undefined)
        throw new Error("meeting insert failed");

      const store = createNotesJobStore(pool);
      expect(await store.enqueue(quotaMeetingId, userId)).toBe("enqueued");
      // Make this job the oldest eligible row so the global claim picks it.
      await pool.query(
        "update jobs set run_at = now() - interval '2 days' where meeting_id = $1",
        [quotaMeetingId],
      );

      // A pipeline that MUST NOT run: the quota gate refuses before any paid work.
      const neverPipeline: NotesPipeline = {
        generate: () => Promise.reject(new Error("generate must not run")),
      };
      const handler = createNotesJobHandler({
        pipeline: neverPipeline,
        source: createNotesSource(),
        writer: createNotesWriter(),
        logger: NOOP_NOTES_LOGGER,
        isOverLlmQuota: () => Promise.resolve(true),
      });
      const worker = createNotesWorker({
        store,
        handler,
        logger: NOOP_NOTES_LOGGER,
      });

      expect(await worker.tickOnce()).toBe(1);

      // Dead-lettered with the typed reason — NOT completed with fallback notes.
      const job = await pool.query<{
        status: string;
        last_error: string | null;
      }>("select status, last_error from jobs where meeting_id = $1", [
        quotaMeetingId,
      ]);
      expect(job.rows[0]).toMatchObject({
        status: "dead",
        last_error: "quota_exceeded",
      });
      // The paywall is visible on the read model.
      const m = await pool.query<{ notes_status: string; notes: unknown }>(
        "select notes_status, notes from meetings where id = $1",
        [quotaMeetingId],
      );
      expect(m.rows[0]?.notes_status).toBe("failed");
      expect(m.rows[0]?.notes).toBeNull();
    });

    it("[cap-e2e] seeded spend past the cap: claims refused, job stays queued, in-flight finishes, ONE alert", async () => {
      // Seed TODAY's ledger past the $50 default cap (global, any user).
      await pool.query(
        `insert into usage_events (user_id, vendor, kind, amount, cost_estimate_usd)
         values ($1, 'openai', 'llm_tokens', 1, 60)`,
        [userId],
      );
      const metering = createMeteringService({
        db: createUsageEventsDb(pool),
        logger: NOOP_METERING_LOGGER,
      });
      const alerts: string[] = [];
      const killSwitch = createKillSwitch({
        spendTodayUsd: () => metering.spendTodayUsd(),
        logger: {
          info: () => {},
          warn: () => {},
          error: (_f, msg) => alerts.push(msg),
        },
      });

      // Tripped over the REAL ledger, alerting exactly once for the day.
      expect(await killSwitch.isTripped()).toBe(true);
      expect(await killSwitch.isTripped()).toBe(true);
      expect(
        alerts.filter((m2) => m2 === "metering.daily_cap_tripped"),
      ).toHaveLength(1);

      // A queued job survives untouched while the cap gates the claim.
      const meeting = await pool.query<{ id: string }>(
        `insert into meetings (user_id, title, started_at, ended_at)
         values ($1, $2, now(), now()) returning id`,
        [userId, "Capped-day call"],
      );
      const capMeetingId = meeting.rows[0]?.id;
      if (capMeetingId === undefined) throw new Error("meeting insert failed");
      const store = createNotesJobStore(pool);
      expect(await store.enqueue(capMeetingId, userId)).toBe("enqueued");
      await pool.query(
        "update jobs set run_at = now() - interval '3 days' where meeting_id = $1",
        [capMeetingId],
      );

      // In-flight-finishes mechanics: the gate is PER-TICK. Tick 1 runs with
      // the cap not yet tripped → claims + the (mock) call finishes even
      // though the cap trips right after the claim; later ticks are refused.
      let capNow = false;
      const handler = createNotesJobHandler({
        pipeline: {
          generate: () => {
            capNow = true; // the cap trips WHILE the job is in flight
            return Promise.resolve({ notes: SALES_NOTES_PARSED, usage: [] });
          },
        },
        source: createNotesSource(),
        writer: createNotesWriter(),
        logger: NOOP_NOTES_LOGGER,
      });
      const worker = createNotesWorker({
        store,
        handler,
        logger: NOOP_NOTES_LOGGER,
        isDailyCapReached: () =>
          capNow ? killSwitch.isTripped() : Promise.resolve(false),
      });

      expect(await worker.tickOnce()).toBe(1); // in-flight work FINISHED
      const done = await pool.query<{ status: string }>(
        "select status from jobs where meeting_id = $1",
        [capMeetingId],
      );
      expect(done.rows[0]?.status).toBe("completed");

      // A NEW queued job is refused while tripped and stays queued, unburned.
      expect(await store.enqueue(capMeetingId, userId)).toBe("enqueued");
      await pool.query(
        "update jobs set run_at = now() - interval '3 days' where meeting_id = $1 and status = 'queued'",
        [capMeetingId],
      );
      expect(await worker.tickOnce()).toBe(0);
      const queued = await pool.query<{ status: string; attempts: number }>(
        "select status, attempts from jobs where meeting_id = $1 and status = 'queued'",
        [capMeetingId],
      );
      expect(queued.rowCount).toBe(1);
      expect(queued.rows[0]?.attempts).toBe(0); // nothing burned, nothing lost
    });
  },
);
