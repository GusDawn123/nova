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

/** Build a {@link TranscriptPersister} over the env-configured service-role client. */
export function createTranscriptPersister(): TranscriptPersister {
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
        .is("ended_at", null);
      if (res.error) {
        throw new Error(`markEnded update failed: ${res.error.message}`);
      }
    },
  };
}
