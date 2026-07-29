import { z } from "zod";
import {
  meetingTranscriptTurnSchema,
  notesStatusSchema,
  storedNotesSchema,
  type MeetingTranscriptTurn,
} from "@nova/shared";

import type {
  MeetingListRow,
  MeetingsReader,
} from "../modules/meetings/index.js";

import { getSupabaseClient } from "./client.js";

/**
 * Supabase adapter for the meetings read surface (Phase 8.5,
 * `docs/DESIGN/notes-ui.md` §6). Service-role client (bypasses RLS — the trusted
 * server-side posture); the SDK never leaks past this module (RULES §5). Explicit
 * column lists, re-parsed at the boundary (RULES §1), same house style as
 * `db/notes-source.ts`.
 *
 * Every read is user-scoped AND `deleted_at is null`, so an unknown, foreign, or
 * soft-deleted meeting is indistinguishable to the caller — the routes turn that
 * into one uniform 404.
 */

const MEETINGS_TABLE = "meetings";
const TRANSCRIPTS_TABLE = "transcripts";
const LIVE_NOTES_TABLE = "live_notes";

/**
 * The meeting columns the list needs.
 *
 * `notes` parses through {@link storedNotesSchema} — the v1 ∪ v2 READ boundary — not
 * `meetingNotesSchema`, which is `version: z.literal(2)` and would throw on every row
 * written before the v2 split. This is the upcast a client reading PostgREST directly
 * could not perform, and the reason `GET /meetings` exists (adr-0006 / live-notes.md
 * §2).
 *
 * `follow_up` is read as a bare presence check (`z.unknown()`): the list only renders
 * a chip, and parsing a draft we are about to discard would let a malformed historical
 * draft break an entire page of unrelated meetings.
 */
const meetingListRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  notes_status: notesStatusSchema,
  notes: storedNotesSchema.nullable(),
  follow_up: z.unknown().nullable(),
});

/** The live-notes preview columns used for the tldr fallback. */
const liveNotesRowSchema = z.object({
  meeting_id: z.string(),
  notes: storedNotesSchema,
});

/** One transcript turn, in the shared wire shape (parsed at the boundary). */
const transcriptRowSchema = meetingTranscriptTurnSchema;

/** Ownership + liveness probe: the id back, or nothing. */
const meetingIdRowSchema = z.object({ id: z.string() });

/**
 * Build a {@link MeetingsReader} over the env-configured service-role client.
 *
 * `listMeetings` is two queries rather than an embedded join. PostgREST *can* embed
 * `live_notes` (its `meeting_id` is the primary key, so the relationship resolves
 * one-to-one), but that inference is implicit and would break silently if the key
 * ever changed. A second explicit query over the page's ids is predictable, is
 * skipped entirely when every meeting already has post-call notes, and reads the way
 * the fallback rule reads.
 */
export function createMeetingsReader(): MeetingsReader {
  return {
    async listMeetings(
      userId: string,
      limit: number,
    ): Promise<MeetingListRow[]> {
      const client = getSupabaseClient();
      const res = await client
        .from(MEETINGS_TABLE)
        .select("id, title, started_at, ended_at, notes_status, notes, follow_up")
        .eq("user_id", userId)
        .is("deleted_at", null)
        // Newest first. `started_at` is nullable (a meeting created but never
        // connected), so nulls sort last and `created_at` breaks the tie —
        // otherwise those rows would head the list forever.
        .order("started_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(limit);
      if (res.error) {
        throw new Error(`listMeetings failed: ${res.error.message}`);
      }

      // No `?? []`: the error check above narrows `data` off its null arm, and a
      // dead fallback here would mask a future shape change rather than surface it.
      const rows = res.data.map((row) => meetingListRowSchema.parse(row));

      // Only calls with no post-call notes can use the live fallback, so the
      // second query is scoped to exactly those — usually none.
      const needsLive = rows.filter((row) => row.notes === null);
      const liveByMeeting = await readLivePreviews(
        needsLive.map((row) => row.id),
        userId,
      );

      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        notesStatus: row.notes_status,
        notes: row.notes,
        liveNotes: liveByMeeting.get(row.id) ?? null,
        hasFollowUp: row.follow_up !== null && row.follow_up !== undefined,
      }));
    },

    async countMeetingsSince(userId: string, since: Date): Promise<number> {
      const client = getSupabaseClient();
      const res = await client
        .from(MEETINGS_TABLE)
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .is("deleted_at", null)
        .gte("started_at", since.toISOString());
      if (res.error) {
        throw new Error(`countMeetingsSince failed: ${res.error.message}`);
      }
      return res.count ?? 0;
    },

    async readTranscript(
      meetingId: string,
      userId: string,
    ): Promise<MeetingTranscriptTurn[] | null> {
      const client = getSupabaseClient();

      // Ownership FIRST, as its own query. A meeting with zero turns is a real
      // answer (an empty transcript), so "no rows returned" from the turns query
      // cannot be read as "no such meeting" — the two must be distinguished
      // before the 404 decision, not after.
      const owner = await client
        .from(MEETINGS_TABLE)
        .select("id")
        .eq("id", meetingId)
        .eq("user_id", userId)
        .is("deleted_at", null)
        .maybeSingle();
      if (owner.error) {
        throw new Error(`readTranscript owner check: ${owner.error.message}`);
      }
      if (owner.data === null) return null;
      meetingIdRowSchema.parse(owner.data);

      const res = await client
        .from(TRANSCRIPTS_TABLE)
        .select("speaker, ts_ms, content")
        .eq("meeting_id", meetingId)
        .eq("user_id", userId)
        .is("deleted_at", null)
        .order("ts_ms", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: true });
      if (res.error) {
        throw new Error(`readTranscript failed: ${res.error.message}`);
      }
      return res.data.map((row) => transcriptRowSchema.parse(row));
    },
  };
}

/** Live-notes previews for the given meetings, keyed by meeting id. */
async function readLivePreviews(
  meetingIds: readonly string[],
  userId: string,
): Promise<Map<string, MeetingListRow["liveNotes"]>> {
  const out = new Map<string, MeetingListRow["liveNotes"]>();
  if (meetingIds.length === 0) return out;

  const client = getSupabaseClient();
  const res = await client
    .from(LIVE_NOTES_TABLE)
    .select("meeting_id, notes")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .in("meeting_id", [...meetingIds]);
  if (res.error) {
    throw new Error(`readLivePreviews failed: ${res.error.message}`);
  }

  for (const row of res.data) {
    const parsed = liveNotesRowSchema.parse(row);
    out.set(parsed.meeting_id, parsed.notes);
  }
  return out;
}
