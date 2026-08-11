import { z } from "zod";
import {
  meetingTranscriptTurnSchema,
  notesStatusSchema,
  storedNotesSchema,
  type MeetingNotes,
  type MeetingTranscriptTurn,
} from "@nova/shared";

import type {
  MeetingListRow,
  MeetingsLogger,
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

/**
 * The meeting columns the list needs, MINUS the notes blob.
 *
 * Everything here stays strict: an id, title, or status that does not parse is a
 * schema/adapter bug, and swallowing it would hide the real breakage.
 *
 * `notes` is deliberately `z.unknown()` and parsed per row by {@link parseStoredNotes}
 * instead — see that function for why one bad document must not take out the page.
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
  notes: z.unknown(),
  follow_up: z.unknown().nullable(),
});

/** One transcript turn, in the shared wire shape (parsed at the boundary). */
const transcriptRowSchema = meetingTranscriptTurnSchema;

/** Logging seam for the reader — ids only, never a payload (RULES §10). */
export interface MeetingsReaderDeps {
  readonly logger?: MeetingsLogger;
}

/** Used when no logger is injected; the routes always inject the real one. */
const SILENT_LOGGER: MeetingsLogger = {
  info: () => undefined,
  error: () => undefined,
};

/**
 * Parse one row's stored notes through {@link storedNotesSchema} — the v1 ∪ v2 READ
 * boundary, not `meetingNotesSchema` (`version: z.literal(2)`, which would throw on
 * every row written before the v2 split). That upcast is the work a client reading
 * PostgREST directly could not do, and the reason `GET /meetings` exists (adr-0006 /
 * live-notes.md §2).
 *
 * why: a `.parse()` here used to run inside a page-wide `.map()`, so ONE stored
 * document matching neither arm threw and answered 500 for the caller's entire
 * history. A malformed blob is now scoped to its own row: that meeting renders with
 * no summary, every other meeting is unaffected, and the row is logged by ID so the
 * bad document is findable. The log carries no notes/transcript content (RULES §10).
 */
function parseStoredNotes(
  value: unknown,
  meetingId: string,
  userId: string,
  logger: MeetingsLogger,
  event: string,
): MeetingNotes | null {
  if (value === null || value === undefined) return null;
  const parsed = storedNotesSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  logger.error({ meeting_id: meetingId, user_id: userId }, event);
  return null;
}

/** Build a {@link MeetingsReader} over the env-configured service-role client. */
export function createMeetingsReader(
  deps: MeetingsReaderDeps = {},
): MeetingsReader {
  const logger = deps.logger ?? SILENT_LOGGER;

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
      const rows = res.data.map((row) => {
        const parsed = meetingListRowSchema.parse(row);
        return {
          ...parsed,
          notes: parseStoredNotes(
            parsed.notes,
            parsed.id,
            userId,
            logger,
            "meetings.list.notes_unreadable",
          ),
        };
      });

      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        notesStatus: row.notes_status,
        notes: row.notes,
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
        // why: this DELIBERATELY diverges from listMeetings, which keeps
        // null-`started_at` meetings (a call created but never connected) and sorts
        // them last. `.gte` drops them, and that is the intent: the port contract is
        // "calls STARTED at or after `since`" (modules/meetings/ports.ts), so a call
        // that never started belongs in no month's count. The list shows everything
        // you own; the counter counts everything you actually held.
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

      // Per-TURN degradation, for the same reason the notes blob degrades per row:
      // one unreadable turn must not blank the whole transcript. The turn is dropped
      // and counted in the logs by meeting id — never by content (RULES §10).
      const turns: MeetingTranscriptTurn[] = [];
      for (const row of res.data) {
        const parsed = transcriptRowSchema.safeParse(row);
        if (!parsed.success) {
          logger.error(
            { meeting_id: meetingId, user_id: userId },
            "meetings.transcript.turn_unreadable",
          );
          continue;
        }
        turns.push(parsed.data);
      }
      return turns;
    },
  };
}
