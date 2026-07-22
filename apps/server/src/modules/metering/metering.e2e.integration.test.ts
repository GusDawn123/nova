import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createUsageEventsDb } from "../../db/usage-events.js";
import { createNotesSource } from "../../db/notes-source.js";
import { createNotesWriter } from "../../db/notes.js";
import {
  createLlmRouter,
  llmConfigSchema,
  makeMockProvider,
} from "../llm/index.js";
import { createNotesJobHandler } from "../notes/handler.js";
import { createNotesPipeline } from "../notes/pipeline.js";
import type { NotesLogger } from "../notes/ports.js";

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
const SALES_NOTES = {
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
  },
);
