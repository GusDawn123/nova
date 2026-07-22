import type { MeetingNotes } from "@nova/shared";

import type { NotesWriter } from "../modules/notes/index.js";

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
