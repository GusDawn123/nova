import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  identifyNotes,
  notesReadResponseSchema,
  type MeetingNotes,
} from "@nova/shared";

import { createNotesJobStore, type NotesJobStore } from "../../db/jobs.js";
import {
  createLiveNotesStore,
  type LiveNotesStore,
} from "../../db/live-notes.js";
import {
  createNoteItemStateStore,
  type NoteItemStateStore,
} from "../../db/note-item-state.js";
import { createFollowUpWriter, createNotesReader } from "../../db/notes.js";
import type { LlmRouter, LlmStreamEvent } from "../llm/index.js";

import { generateFollowUp } from "./follow-up.js";
import type { NotesLogger } from "./ports.js";
import { reconcileIds } from "./reconcile-ids.js";
import { createNotesRoutes } from "./routes.js";

/**
 * Action-item completion over the real REST surface and real Postgres (Phase 8.5,
 * `docs/DESIGN/notes-ui.md` §6.3). Split from `routes.integration.test.ts`, which
 * was already past the ~400-line cap (RULES §2).
 *
 * The cases worth the setup cost are the identity ones. A "look the id up and
 * return the flag" implementation passes the happy path and fails every one of the
 * regenerate cases below — which is the entire reason `item_text` is stored.
 *
 * Self-skips without the stack env.
 */

const dbUrl = process.env.SUPABASE_DB_URL;
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const hasStack = Boolean(dbUrl && url && serviceRoleKey && anonKey);

const noPersist = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

/** Notes carrying the given action-item texts, ids minted positionally. */
function notesWithItems(
  texts: readonly string[],
  source: "generated" | "live" = "generated",
): MeetingNotes {
  return identifyNotes(
    {
      conversationType: "sales",
      title: "Northwind discovery",
      tldr: "Comparing three vendors.",
      overview: "Discovery call covering budget and timeline.",
      decisions: [],
      actionItems: texts.map((text) => ({
        text,
        owner: null,
        deadline: null,
        deadlineRaw: null,
        quote: null,
      })),
      openQuestions: [],
      risks: [],
      typeInsights: { kind: "sales", objections: [], buyingSignals: [] },
    },
    source,
  );
}

/** A router that never runs here — follow-up is not under test. */
function idleRouter(): LlmRouter {
  return {
    async *stream(): AsyncGenerator<LlmStreamEvent> {
      await Promise.resolve();
      yield { type: "done", usage: {} };
    },
  };
}

function silentLogger(): NotesLogger {
  return { info: () => undefined, error: () => undefined };
}

describe.skipIf(!hasStack)("action-item completion (local stack)", () => {
  let pool: Pool;
  let admin: ReturnType<typeof createClient>;
  let store: NotesJobStore;
  let liveNotes: LiveNotesStore;
  let itemState: NoteItemStateStore;
  let app: FastifyInstance;
  /** A second app with completion UNWIRED, for the DB-less posture. */
  let unwiredApp: FastifyInstance;

  let tokenA: string;
  let userAId: string;
  let userBId: string;
  const userIds: string[] = [];

  async function createUser(
    label: string,
  ): Promise<{ id: string; token: string }> {
    if (!url || !anonKey) throw new Error("stack env missing");
    const email = `nis-${label}-${randomUUID()}@nova.test`;
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
       values ($1, 'Northwind discovery', now(), now(), 'none') returning id`,
      [ownerId],
    );
    const id = r.rows[0]?.id;
    if (id === undefined) throw new Error("meeting insert returned no id");
    return id;
  }

  async function setNotes(id: string, notes: MeetingNotes): Promise<void> {
    await pool.query(
      `update meetings set notes = $2::jsonb, notes_status = 'completed',
         notes_generated_at = now() where id = $1`,
      [id, JSON.stringify(notes)],
    );
  }

  function buildApp(withCompletion: boolean): FastifyInstance {
    const instance = Fastify({ logger: false });
    void instance.register(
      createNotesRoutes({
        reader: createNotesReader(),
        liveNotes,
        followUpWriter: createFollowUpWriter(),
        store,
        followUp: generateFollowUp({
          router: idleRouter(),
          logger: silentLogger(),
        }),
        logger: silentLogger(),
        now: () => new Date("2026-07-28T12:00:00Z"),
        ...(withCompletion ? { noteItemState: itemState } : {}),
      }),
    );
    return instance;
  }

  beforeAll(async () => {
    if (!dbUrl || !url || !serviceRoleKey) throw new Error("stack env missing");
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    admin = createClient(url, serviceRoleKey, noPersist);
    store = createNotesJobStore(pool);
    liveNotes = createLiveNotesStore(pool);
    itemState = createNoteItemStateStore(pool);

    const a = await createUser("a");
    userAId = a.id;
    tokenA = a.token;
    userIds.push(userAId);
    const b = await createUser("b");
    userBId = b.id;
    userIds.push(userBId);

    app = buildApp(true);
    unwiredApp = buildApp(false);
    await app.ready();
    await unwiredApp.ready();
  });

  afterAll(async () => {
    await app.close();
    await unwiredApp.close();
    for (const id of userIds) {
      await pool.query("delete from note_item_state where user_id = $1", [id]);
      await pool.query("delete from live_notes where user_id = $1", [id]);
      await pool.query("delete from jobs where user_id = $1", [id]);
      await pool.query("delete from meetings where user_id = $1", [id]);
      await admin.auth.admin.deleteUser(id);
    }
    await pool.end();
  });

  beforeEach(async () => {
    for (const id of userIds) {
      await pool.query("delete from note_item_state where user_id = $1", [id]);
      await pool.query("delete from live_notes where user_id = $1", [id]);
      await pool.query("delete from meetings where user_id = $1", [id]);
    }
  });

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function check(
    meetingId: string,
    itemId: string,
    completed = true,
  ): Promise<number> {
    const res = await app.inject({
      method: "PUT",
      url: `/meetings/${meetingId}/notes/items/${itemId}`,
      headers: auth(tokenA),
      payload: { completed },
    });
    return res.statusCode;
  }

  async function readCompleted(meetingId: string): Promise<string[]> {
    const res = await app.inject({
      method: "GET",
      url: `/meetings/${meetingId}/notes`,
      headers: auth(tokenA),
    });
    expect(res.statusCode).toBe(200);
    return notesReadResponseSchema.parse(res.json()).completed_item_ids;
  }

  // --- the happy path --------------------------------------------------------

  it("checks an item and surfaces it on the next read", async () => {
    const id = await newMeeting(userAId);
    await setNotes(id, notesWithItems(["Send the comparison.", "Loop in ops."]));

    expect(await check(id, "a1")).toBe(200);
    expect(await readCompleted(id)).toEqual(["a1"]);
  });

  it("unchecks, and the uncheck survives a re-read", async () => {
    const id = await newMeeting(userAId);
    await setNotes(id, notesWithItems(["Send the comparison."]));

    await check(id, "a1");
    expect(await check(id, "a1", false)).toBe(200);
    expect(await readCompleted(id)).toEqual([]);
  });

  it("is idempotent — checking twice is still checked once", async () => {
    const id = await newMeeting(userAId);
    await setNotes(id, notesWithItems(["Send the comparison."]));

    await check(id, "a1");
    await check(id, "a1");
    expect(await readCompleted(id)).toEqual(["a1"]);
  });

  it("returns an empty array when nothing is checked", async () => {
    const id = await newMeeting(userAId);
    await setNotes(id, notesWithItems(["Send the comparison."]));

    expect(await readCompleted(id)).toEqual([]);
  });

  // --- the identity rules ----------------------------------------------------

  it("KEEPS the check when a regenerate merely reworded the item", async () => {
    const id = await newMeeting(userAId);
    await setNotes(id, notesWithItems(["Send the scope comparison."]));
    await check(id, "a1");

    // What a regenerate leaves behind: same task, post-call phrasing.
    await setNotes(id, notesWithItems(["Send Dana the scope comparison."]));

    expect(await readCompleted(id)).toEqual(["a1"]);
  });

  it("DROPS the check when a regenerate put a different item at that id", async () => {
    // The failure the whole design exists to prevent. A lookup by id alone would
    // report the user finished a task they have never seen.
    const id = await newMeeting(userAId);
    await setNotes(id, notesWithItems(["Send the scope comparison."]));
    await check(id, "a1");

    await setNotes(id, notesWithItems(["Confirm whether SSO is in scope."]));

    expect(await readCompleted(id)).toEqual([]);
  });

  it("carries a mid-call check through the live→final swap", async () => {
    // The integration that makes checking during a call worth anything. The user
    // checks an item on the LIVE preview; at hangup `reconcileIds` carries the live
    // id onto the post-call item, so the stored row matches by id, and the text
    // guard clears it even though the post-call pass reworded the task.
    const id = await newMeeting(userAId);
    const live = notesWithItems(
      ["Send the scope comparison.", "Loop in procurement."],
      "live",
    );
    await pool.query(
      `insert into live_notes (meeting_id, user_id, notes, rev)
       values ($1, $2, $3::jsonb, 4)`,
      [id, userAId, JSON.stringify(live)],
    );

    expect(await check(id, "a1")).toBe(200);
    expect(await readCompleted(id)).toEqual(["a1"]);

    // Hangup: the post-call pass reworded both items and would mint fresh ids —
    // reconcileIds carries the live ones across, exactly as the handler does.
    const rawFinal = notesWithItems([
      "Send Dana the scope comparison.",
      "Loop in procurement about pre-pay.",
    ]);
    await setNotes(id, reconcileIds(live, rawFinal));

    expect(await readCompleted(id)).toEqual(["a1"]);
  });

  // --- the guards ------------------------------------------------------------

  it("404s an item id that is not in the notes", async () => {
    const id = await newMeeting(userAId);
    await setNotes(id, notesWithItems(["Only one item."]));

    expect(await check(id, "a9")).toBe(404);
  });

  it("404s a DECISION id — only action items are checkable", async () => {
    const id = await newMeeting(userAId);
    await setNotes(id, notesWithItems(["An action."]));

    expect(await check(id, "d1")).toBe(404);
  });

  it("404s a foreign meeting without revealing it exists", async () => {
    const foreign = await newMeeting(userBId);
    await setNotes(foreign, notesWithItems(["B's private task."]));

    expect(await check(foreign, "a1")).toBe(404);
    // And nothing was written for it.
    const rows = await pool.query(
      "select 1 from note_item_state where meeting_id = $1",
      [foreign],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("404s a soft-deleted meeting", async () => {
    const id = await newMeeting(userAId);
    await setNotes(id, notesWithItems(["Send the comparison."]));
    await pool.query("update meetings set deleted_at = now() where id = $1", [
      id,
    ]);

    expect(await check(id, "a1")).toBe(404);
  });

  it("404s a meeting that has no notes at all yet", async () => {
    const id = await newMeeting(userAId);
    expect(await check(id, "a1")).toBe(404);
  });

  it("404s (never 400s) a malformed item id", async () => {
    const id = await newMeeting(userAId);
    await setNotes(id, notesWithItems(["Send the comparison."]));

    const res = await app.inject({
      method: "PUT",
      url: `/meetings/${id}/notes/items/not-an-id`,
      headers: auth(tokenA),
      payload: { completed: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s a body that is not {completed: boolean}", async () => {
    const id = await newMeeting(userAId);
    await setNotes(id, notesWithItems(["Send the comparison."]));

    const res = await app.inject({
      method: "PUT",
      url: `/meetings/${id}/notes/items/a1`,
      headers: auth(tokenA),
      payload: { completed: "yes" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("401s without a token", async () => {
    const id = await newMeeting(userAId);
    const res = await app.inject({
      method: "PUT",
      url: `/meetings/${id}/notes/items/a1`,
      payload: { completed: true },
    });
    expect(res.statusCode).toBe(401);
  });

  it("503s the WRITE when completion is unwired, but still serves the read", async () => {
    // A write that silently no-ops IS the unchecks-itself-on-refresh bug. The read
    // may degrade to empty; the write must say so.
    const id = await newMeeting(userAId);
    await setNotes(id, notesWithItems(["Send the comparison."]));

    const write = await unwiredApp.inject({
      method: "PUT",
      url: `/meetings/${id}/notes/items/a1`,
      headers: auth(tokenA),
      payload: { completed: true },
    });
    expect(write.statusCode).toBe(503);
    expect(write.json()).toEqual({ error: "completion_unavailable" });

    const read = await unwiredApp.inject({
      method: "GET",
      url: `/meetings/${id}/notes`,
      headers: auth(tokenA),
    });
    expect(read.statusCode).toBe(200);
    expect(
      notesReadResponseSchema.parse(read.json()).completed_item_ids,
    ).toEqual([]);
  });

  it("stores the text from the NOTES, not from anything the client sends", async () => {
    // The guard's anchor. A client that could seed item_text could pin a checkmark
    // on forever by claiming text that matches whatever the notes say next.
    const id = await newMeeting(userAId);
    await setNotes(id, notesWithItems(["Send the scope comparison."]));

    await app.inject({
      method: "PUT",
      url: `/meetings/${id}/notes/items/a1`,
      headers: auth(tokenA),
      // Extra keys are ignored by the body schema; assert the DB agrees.
      payload: { completed: true, item_text: "anything I like" },
    });

    const row = await pool.query<{ item_text: string }>(
      "select item_text from note_item_state where meeting_id = $1",
      [id],
    );
    expect(row.rows[0]?.item_text).toBe("Send the scope comparison.");
  });
});
