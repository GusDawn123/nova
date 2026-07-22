import { type MeetingNotes, meetingNotesSchema } from "@nova/shared";
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

/** Denormalized notes-generation state the product reads without joining `jobs`. */
export const notesStatusSchema = z.enum([
  "none",
  "queued",
  "processing",
  "completed",
  "failed",
]);

export type NotesStatus = z.infer<typeof notesStatusSchema>;

/**
 * Runtime shape of a `meetings` row (the columns the server adapters touch). The
 * RAG columns `ended_at` (call finished) and `indexed_at` (memory caught up) drive
 * the completion sweeper; `started_at` seeds the meeting chunk header's date. The
 * Phase 5 notes columns: `notes` is ONLY ever a `meetingNotesSchema`-valid object
 * (the output ladder guarantees it, so it is parsed as such here, not left `unknown`);
 * `notes_status` is the read model, `follow_up` the latest draft (Task 5 owns its shape).
 */
export const meetingRowSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  title: z.string(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  indexed_at: z.string().nullable(),
  notes: meetingNotesSchema.nullable(),
  notes_status: notesStatusSchema,
  notes_generated_at: z.string().nullable(),
  follow_up: z.record(z.string(), z.unknown()).nullable(),
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

/** The `jobs` queue kind (single-valued today; the CHECK keeps it a closed set). */
export const jobKindSchema = z.enum(["generate_notes"]);
export type JobKind = z.infer<typeof jobKindSchema>;

/** The `jobs` execution lifecycle (NOT the product-facing `meetings.notes_status`). */
export const jobStatusSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "dead",
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

/**
 * Runtime shape of a `jobs` row — the durable notes-generation queue. Service-role
 * only (RLS enabled, zero policies). `usage` is per-attempt token telemetry (Task 2
 * owns its element shape — the Phase 6 metering seam); `raw_output` keeps a failed
 * generation's raw model text (malformed JSON lives here, never in `meetings.notes`).
 */
export const jobRowSchema = z.object({
  id: z.string().uuid(),
  kind: jobKindSchema,
  meeting_id: z.string().uuid(),
  user_id: z.string().uuid(),
  status: jobStatusSchema,
  attempts: z.number(),
  max_attempts: z.number(),
  run_at: z.string(),
  locked_at: z.string().nullable(),
  locked_by: z.string().nullable(),
  last_error: z.string().nullable(),
  raw_output: z.string().nullable(),
  usage: z.array(z.unknown()).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type JobRow = z.infer<typeof jobRowSchema>;

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
          notes?: MeetingNotes | null;
          notes_status?: NotesStatus;
          notes_generated_at?: string | null;
          follow_up?: Record<string, unknown> | null;
          created_at?: string;
          deleted_at?: string | null;
        };
        Update: Partial<MeetingRow>;
        Relationships: [];
      };
      jobs: {
        Row: JobRow;
        Insert: {
          kind: JobKind;
          meeting_id: string;
          user_id: string;
          id?: string;
          status?: JobStatus;
          attempts?: number;
          max_attempts?: number;
          run_at?: string;
          locked_at?: string | null;
          locked_by?: string | null;
          last_error?: string | null;
          raw_output?: string | null;
          usage?: unknown[] | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<JobRow>;
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
