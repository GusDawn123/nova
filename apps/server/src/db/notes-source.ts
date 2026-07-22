import { z } from "zod";

import type {
  NotesSource,
  NotesSourceMeeting,
  TranscriptTurn,
} from "../modules/notes/index.js";

import { getSupabaseClient } from "./client.js";

/**
 * Supabase adapter for the notes handler's {@link NotesSource} port — the meeting
 * meta + final transcript turns a generation job reads. Service-role client
 * (bypasses RLS, the trusted server-side posture); the SDK never leaks past this
 * module (RULES §5). Reads are re-parsed at the boundary (RULES §1). Explicit
 * column lists, same house style as `db/rag-indexer.ts`.
 *
 * `loadMeeting` deliberately does NOT filter on `deleted_at`: it returns the row's
 * `deleted_at` so the handler can tell a soft-deleted meeting (complete the job as a
 * no-op) from a genuinely missing one (terminal fail). `loadTranscript` IS
 * `deleted_at`-aware — a soft-deleted final never feeds a summary.
 */

const MEETINGS_TABLE = "meetings";
const TRANSCRIPTS_TABLE = "transcripts";

/** The meeting columns the handler needs (parsed at the boundary). */
const meetingRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  title: z.string(),
  started_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
});

/** One final transcript turn, ordered for chunking/summarisation. */
const transcriptTurnRowSchema = z.object({
  content: z.string(),
  speaker: z.string().nullable(),
  ts_ms: z.number().nullable(),
});

/** Build a {@link NotesSource} over the env-configured service-role client. */
export function createNotesSource(): NotesSource {
  return {
    async loadMeeting(
      meetingId: string,
      userId: string,
    ): Promise<NotesSourceMeeting | null> {
      const client = getSupabaseClient();
      const res = await client
        .from(MEETINGS_TABLE)
        .select("id, user_id, title, started_at, deleted_at")
        .eq("id", meetingId)
        .eq("user_id", userId)
        .maybeSingle();
      if (res.error) {
        throw new Error(`loadMeeting failed: ${res.error.message}`);
      }
      if (res.data === null) return null;
      const row = meetingRowSchema.parse(res.data);
      return {
        id: row.id,
        userId: row.user_id,
        title: row.title,
        startedAt: row.started_at,
        deletedAt: row.deleted_at,
      };
    },

    async loadTranscript(
      meetingId: string,
      userId: string,
    ): Promise<TranscriptTurn[]> {
      const client = getSupabaseClient();
      const res = await client
        .from(TRANSCRIPTS_TABLE)
        .select("content, speaker, ts_ms")
        .eq("meeting_id", meetingId)
        .eq("user_id", userId)
        .is("deleted_at", null)
        // Turn time first; created_at breaks ties (untimed finals sort last).
        .order("ts_ms", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: true });
      if (res.error) {
        throw new Error(`loadTranscript failed: ${res.error.message}`);
      }
      const rows = z.array(transcriptTurnRowSchema).parse(res.data);
      return rows.map((r): TranscriptTurn => ({
        speaker: r.speaker,
        text: r.content,
        tsMs: r.ts_ms,
      }));
    },
  };
}
