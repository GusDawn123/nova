import { z } from "zod";

import type {
  TranscriptFinalRow,
  TranscriptPersister,
} from "../modules/live/ports.js";

import { getSupabaseClient } from "./client.js";

/**
 * Supabase adapter for the live session's {@link TranscriptPersister} port —
 * durable storage for FINAL transcript text and call-completion marking. Uses the
 * service-role client (bypasses RLS, the intended posture for trusted server-side
 * writes); the raw Supabase SDK never leaks past this module (RULES §5). Raw audio
 * is never persisted — only transcript TEXT finals reach here (the session drops
 * partials before calling `saveFinal`).
 */

const TRANSCRIPTS_TABLE = "transcripts";
const MEETINGS_TABLE = "meetings";

/**
 * The single column `verifyMeetingOwnership` reads back — parsed at the boundary so
 * a shape drift from the DB (vendor output is hostile, RULES) fails loudly rather
 * than silently green-lighting a session on a malformed row.
 */
const meetingIdRowSchema = z.object({ id: z.string().uuid() });

/**
 * Optional wiring for {@link createTranscriptPersister}. `onEnded` is the EAGER
 * best-effort enqueue seam (adr-0006 §4): the wiring site (app.ts) passes a callback
 * that kicks off `NotesJobStore.enqueue`, so the durable `pg`-Pool queue never leaks
 * into this supabase-js adapter. It fires ONLY when `markEnded` actually stamped the
 * meeting (a first, real disposal), so a belt-and-suspenders second disposal is a
 * true no-op — the enqueue happens at most once per call from this path (the sweep
 * backstop covers a crash between the stamp and the enqueue).
 */
export interface TranscriptPersisterOptions {
  onEnded?: (meetingId: string, userId: string) => void;
}

/** Build a {@link TranscriptPersister} over the env-configured service-role client. */
export function createTranscriptPersister(
  options: TranscriptPersisterOptions = {},
): TranscriptPersister {
  const { onEnded } = options;
  return {
    async saveFinal(row: TranscriptFinalRow): Promise<void> {
      const client = getSupabaseClient();
      const res = await client.from(TRANSCRIPTS_TABLE).insert({
        meeting_id: row.meetingId,
        user_id: row.userId,
        content: row.content,
        speaker: row.speaker,
        ts_ms: row.tsMs,
      });
      if (res.error) {
        throw new Error(`saveFinal insert failed: ${res.error.message}`);
      }
    },

    async markEnded(meetingId: string, userId: string): Promise<void> {
      const client = getSupabaseClient();
      // Idempotent: only stamp where `ended_at` is still null, so a second
      // disposal (belt-and-suspenders transport close) never moves the timestamp.
      const res = await client
        .from(MEETINGS_TABLE)
        .update({ ended_at: new Date().toISOString() })
        .eq("id", meetingId)
        .eq("user_id", userId)
        .is("ended_at", null)
        // `.select` returns the rows this stamp actually changed, so the eager
        // enqueue fires exactly once (a second disposal matches nothing).
        .select("id");
      if (res.error) {
        throw new Error(`markEnded update failed: ${res.error.message}`);
      }
      const stamped = res.data.length > 0;
      if (stamped && onEnded !== undefined) {
        // Best-effort: the enqueue is fire-and-forget inside the callback and must
        // never throw into (or delay) the call-teardown path.
        onEnded(meetingId, userId);
      }
    },

    async verifyMeetingOwnership(
      meetingId: string,
      userId: string,
    ): Promise<boolean> {
      const client = getSupabaseClient();
      // Service role bypasses RLS, so THIS query is the parentage guard for the
      // live write path (the DB `with_check` only covers Data-API/JWT writes). A
      // meeting counts as usable only if it exists, is owned by the caller, and is
      // not soft-deleted — mirroring the transcript-parentage RLS predicate.
      const res = await client
        .from(MEETINGS_TABLE)
        .select("id")
        .eq("id", meetingId)
        .eq("user_id", userId)
        .is("deleted_at", null)
        .maybeSingle();
      if (res.error) {
        // A DB error must NOT be read as "not owned" — throw so the session fails
        // CLOSED (the caller refuses the start rather than silently accepting it).
        throw new Error(
          `verifyMeetingOwnership query failed: ${res.error.message}`,
        );
      }
      if (res.data === null) return false;
      // Parse the row shape at the boundary before trusting it (RULES).
      meetingIdRowSchema.parse(res.data);
      return true;
    },
  };
}
