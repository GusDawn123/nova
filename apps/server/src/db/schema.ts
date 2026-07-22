import { z } from "zod";

/**
 * Shared `_smoke` contract for the db adapter: the runtime validator (zod) plus a
 * minimal `Database` type for `@supabase/supabase-js`. Kept in one place so the
 * client's SDK typing and the smoke functions' validation never drift. A real
 * project regenerates the `Database` type with `supabase gen types`; this is the
 * hand-written minimum for the single scaffold table.
 */

/** Runtime shape of a `_smoke` row, validated on every read (vendor output is hostile). */
export const smokeRowSchema = z.object({
  id: z.string().uuid(),
  note: z.string(),
  created_at: z.string(),
  deleted_at: z.string().nullable(),
});

export type SmokeRow = z.infer<typeof smokeRowSchema>;

/**
 * Runtime shape of a `deletion_requests` row, validated on every read. `processed_at`
 * is the pending-vs-done lifecycle marker (NULL = pending) — not a soft-delete column.
 */
export const deletionRequestRowSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  requested_at: z.string(),
  processed_at: z.string().nullable(),
});

export type DeletionRequestRow = z.infer<typeof deletionRequestRowSchema>;

/**
 * Runtime shape of a `meetings` row (the columns the server adapters touch). The
 * RAG columns `ended_at` (call finished) and `indexed_at` (memory caught up) drive
 * the completion sweeper; `started_at` seeds the meeting chunk header's date.
 */
export const meetingRowSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  title: z.string(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  indexed_at: z.string().nullable(),
  created_at: z.string(),
  deleted_at: z.string().nullable(),
});

export type MeetingRow = z.infer<typeof meetingRowSchema>;

/**
 * Runtime shape of a `transcripts` row. `speaker` / `ts_ms` are the diarization +
 * turn timing the live session persists for FINAL utterances (nullable — the STT
 * vendor may omit either); reads order by `ts_ms` (fallback `created_at`).
 */
export const transcriptRowSchema = z.object({
  id: z.string().uuid(),
  meeting_id: z.string().uuid(),
  user_id: z.string().uuid(),
  content: z.string(),
  speaker: z.string().nullable(),
  ts_ms: z.number().nullable(),
  created_at: z.string(),
  deleted_at: z.string().nullable(),
});

export type TranscriptRow = z.infer<typeof transcriptRowSchema>;

export interface Database {
  public: {
    Tables: {
      _smoke: {
        Row: SmokeRow;
        Insert: {
          note: string;
          id?: string;
          created_at?: string;
          deleted_at?: string | null;
        };
        Update: Partial<SmokeRow>;
        Relationships: [];
      };
      profiles: {
        // Only the columns the server adapter touches are modelled here (the
        // account-deletion tombstone). A real project regenerates this with
        // `supabase gen types`; this is the hand-written minimum.
        Row: {
          id: string;
          display_name: string | null;
          created_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id: string;
          display_name?: string | null;
          created_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          display_name?: string | null;
          created_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      deletion_requests: {
        Row: DeletionRequestRow;
        Insert: {
          user_id: string;
          id?: string;
          requested_at?: string;
          processed_at?: string | null;
        };
        Update: Partial<DeletionRequestRow>;
        Relationships: [];
      };
      meetings: {
        Row: MeetingRow;
        Insert: {
          user_id: string;
          title: string;
          id?: string;
          started_at?: string | null;
          ended_at?: string | null;
          indexed_at?: string | null;
          created_at?: string;
          deleted_at?: string | null;
        };
        Update: Partial<MeetingRow>;
        Relationships: [];
      };
      transcripts: {
        Row: TranscriptRow;
        Insert: {
          meeting_id: string;
          user_id: string;
          content: string;
          speaker?: string | null;
          ts_ms?: number | null;
          id?: string;
          created_at?: string;
          deleted_at?: string | null;
        };
        Update: Partial<TranscriptRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
