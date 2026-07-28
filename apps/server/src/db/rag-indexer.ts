import { z } from "zod";

import type { TranscriptTurn } from "../modules/rag/index.js";
import type { RagIndexerDb, UnindexedMeeting } from "../modules/rag/indexer.js";

import { getSupabaseClient } from "./client.js";

/**
 * Supabase adapter for the sweeper's {@link RagIndexerDb} port. Service-role client
 * (bypasses RLS — trusted server-side background work); the SDK never leaks past
 * this module (RULES §5). Reads are re-parsed at the boundary (RULES: parse every
 * boundary), and every op throws on a DB error so the sweeper's per-meeting catch
 * can leave `indexed_at` null for a retry.
 */

const MEETINGS_TABLE = "meetings";
const TRANSCRIPTS_TABLE = "transcripts";

/** The meeting columns the sweeper reads. */
const unindexedRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  title: z.string(),
  started_at: z.string().nullable(),
});

/** One final transcript turn as loaded for chunking. */
const transcriptTurnRowSchema = z.object({
  content: z.string(),
  speaker: z.string().nullable(),
  ts_ms: z.number().nullable(),
});

/** Build a {@link RagIndexerDb} over the env-configured service-role client. */
export function createRagIndexerDb(): RagIndexerDb {
  return {
    async fetchUnindexed(limit: number): Promise<UnindexedMeeting[]> {
      const client = getSupabaseClient();
      // The Task 1 partial index: finished, live, not-yet-indexed. Oldest
      // completion first so a backlog drains in the order calls ended.
      const res = await client
        .from(MEETINGS_TABLE)
        .select("id, user_id, title, started_at")
        .not("ended_at", "is", null)
        .is("indexed_at", null)
        .is("deleted_at", null)
        .order("ended_at", { ascending: true })
        .limit(limit);
      if (res.error) {
        throw new Error(`fetchUnindexed failed: ${res.error.message}`);
      }
      const rows = z.array(unindexedRowSchema).parse(res.data);
      return rows.map((r): UnindexedMeeting => ({
        id: r.id,
        userId: r.user_id,
        title: r.title,
        // Date portion of started_at seeds the chunk header `Meeting: … (date)`.
        ...(r.started_at !== null ? { date: r.started_at.slice(0, 10) } : {}),
      }));
    },

    async fetchTranscript(
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
        // Order by turn time; created_at breaks ties (and orders any untimed
        // finals, which sort last).
        .order("ts_ms", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: true });
      if (res.error) {
        throw new Error(`fetchTranscript failed: ${res.error.message}`);
      }
      const rows = z.array(transcriptTurnRowSchema).parse(res.data);
      return rows.map((r): TranscriptTurn => ({
        speaker: r.speaker,
        text: r.content,
        tsMs: r.ts_ms,
      }));
    },

    async markIndexed(meetingId: string, userId: string): Promise<void> {
      const client = getSupabaseClient();
      // Idempotent: only stamp where still null, so a re-sweep never moves it.
      const res = await client
        .from(MEETINGS_TABLE)
        .update({ indexed_at: new Date().toISOString() })
        .eq("id", meetingId)
        .eq("user_id", userId)
        .is("indexed_at", null);
      if (res.error) {
        throw new Error(`markIndexed failed: ${res.error.message}`);
      }
    },
  };
}
