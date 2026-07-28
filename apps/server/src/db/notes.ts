import { z } from "zod";
import {
  followUpStoredSchema,
  notesStatusSchema,
  storedNotesSchema,
  type FollowUpDraft,
  type MeetingNotes,
} from "@nova/shared";

import type {
  FollowUpWriter,
  NotesReader,
  NotesReadModel,
  NotesWriter,
} from "../modules/notes/index.js";

import { getSupabaseClient } from "./client.js";

/**
 * Supabase adapter for the notes handler's {@link NotesWriter} port — the ONE place
 * a generated notes object is persisted and the read model flips to 'completed'
 * (adr-0006 §2). Service-role client (bypasses RLS); the SDK never leaks past this
 * module (RULES §5).
 *
 * The write is a user-scoped UPDATE of the meeting's notes columns (the meeting row
 * already exists — it is the call being summarised), guarded on `deleted_at is null`
 * so a race that soft-deletes the meeting mid-generation never revives it. Idempotent
 * by construction: re-running a job overwrites the same three columns with the same
 * values, so at-least-once execution stays correct (adr §3). `notes_status` flips to
 * 'completed' HERE, atomically with the notes write, so a completed job whose write
 * failed can never read as ready (the store's `complete()` deliberately leaves it).
 */

const MEETINGS_TABLE = "meetings";

/** Build a {@link NotesWriter} over the env-configured service-role client. */
export function createNotesWriter(): NotesWriter {
  return {
    async writeNotes(
      meetingId: string,
      userId: string,
      notes: MeetingNotes,
      generatedAt: Date,
    ): Promise<void> {
      const client = getSupabaseClient();
      const res = await client
        .from(MEETINGS_TABLE)
        .update({
          notes,
          notes_status: "completed",
          notes_generated_at: generatedAt.toISOString(),
        })
        .eq("id", meetingId)
        .eq("user_id", userId)
        .is("deleted_at", null);
      if (res.error) {
        throw new Error(`writeNotes failed: ${res.error.message}`);
      }
    },
  };
}

/**
 * The meeting's notes columns as read for the REST surface (parsed at the boundary).
 *
 * `notes` uses {@link storedNotesSchema}, the v1 ∪ v2 READ boundary — NOT
 * `meetingNotesSchema`, which is `version: z.literal(2)` and would throw on every
 * row written before the v2 split, turning this endpoint into a permanent 500 for
 * those meetings. Rows upcast to v2 in code on the way out; writers only ever emit
 * v2, so no backfill migration is needed (docs/DESIGN/live-notes.md §2).
 */
const notesReadRowSchema = z.object({
  notes_status: notesStatusSchema,
  notes: storedNotesSchema.nullable(),
  follow_up: followUpStoredSchema.nullable(),
  notes_generated_at: z.string().nullable(),
});

/**
 * Build a {@link NotesReader} over the env-configured service-role client. The read
 * is user-scoped AND `deleted_at is null`, so an unknown, foreign, or soft-deleted
 * meeting ALL return `null` — the routes turn that into one uniform 404 (no existence
 * leak). Explicit column list, re-parsed at the boundary (RULES §1); `notes`/
 * `follow_up` are only ever ladder-valid jsonb, so the parse never rejects live data.
 */
export function createNotesReader(): NotesReader {
  return {
    async readNotes(
      meetingId: string,
      userId: string,
    ): Promise<NotesReadModel | null> {
      const client = getSupabaseClient();
      const res = await client
        .from(MEETINGS_TABLE)
        .select("notes_status, notes, follow_up, notes_generated_at")
        .eq("id", meetingId)
        .eq("user_id", userId)
        .is("deleted_at", null)
        .maybeSingle();
      if (res.error) {
        throw new Error(`readNotes failed: ${res.error.message}`);
      }
      if (res.data === null) return null;
      const row = notesReadRowSchema.parse(res.data);
      return {
        notesStatus: row.notes_status,
        notes: row.notes,
        followUp: row.follow_up,
        notesGeneratedAt: row.notes_generated_at,
      };
    },
  };
}

/**
 * Build a {@link FollowUpWriter} over the env-configured service-role client. The
 * write is a user-scoped UPDATE of `meetings.follow_up`, guarded on `deleted_at is
 * null` (a race that soft-deletes the meeting mid-request never revives its draft).
 * Stores the draft plus its `generated_at` (adr-0006 §8 data-model shape).
 */
export function createFollowUpWriter(): FollowUpWriter {
  return {
    async writeFollowUp(
      meetingId: string,
      userId: string,
      draft: FollowUpDraft,
      generatedAt: Date,
    ): Promise<void> {
      const client = getSupabaseClient();
      const res = await client
        .from(MEETINGS_TABLE)
        .update({
          follow_up: { ...draft, generated_at: generatedAt.toISOString() },
        })
        .eq("id", meetingId)
        .eq("user_id", userId)
        .is("deleted_at", null);
      if (res.error) {
        throw new Error(`writeFollowUp failed: ${res.error.message}`);
      }
    },
  };
}
