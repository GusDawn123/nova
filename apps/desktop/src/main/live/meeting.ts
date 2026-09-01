import { z } from "zod";

/**
 * Creates the meeting row a live session hangs off. The server's `/live`
 * socket refuses a `session.start` whose meeting_id the caller doesn't own
 * (`meeting_forbidden`), so the row must exist first.
 *
 * Straight to Supabase's PostgREST with the user's own JWT — the exact path
 * the mobile app takes and the one the RLS suite proves (owners may insert
 * their own `meetings` rows; nothing else). There is deliberately no server
 * endpoint for this: the row is the user's own data.
 */

const createdRowsSchema = z.array(z.object({ id: z.string().uuid() })).min(1);

export interface CreateMeetingDeps {
  supabaseUrl: string;
  anonKey: string;
  accessToken: string;
  userId: string;
  fetch: typeof globalThis.fetch;
}

export type CreateMeetingResult =
  { ok: true; meetingId: string } | { ok: false; message: string };

export async function createMeetingRow(
  deps: CreateMeetingDeps,
): Promise<CreateMeetingResult> {
  try {
    const response = await deps.fetch(
      `${deps.supabaseUrl.replace(/\/+$/, "")}/rest/v1/meetings`,
      {
        method: "POST",
        headers: {
          apikey: deps.anonKey,
          Authorization: `Bearer ${deps.accessToken}`,
          "Content-Type": "application/json",
          // Ask PostgREST to hand back the inserted row — its id IS the result.
          Prefer: "return=representation",
        },
        // A plain title — the notes pipeline renames the meeting after the
        // call. `started_at` is stamped here because history's day groups and
        // durations derive from it; a null start reads as UNDATED forever.
        body: JSON.stringify({
          user_id: deps.userId,
          title: "Desktop call",
          started_at: new Date().toISOString(),
        }),
      },
    );
    if (!response.ok) {
      return {
        ok: false,
        message: `Could not create the meeting (${String(response.status)}).`,
      };
    }
    const parsed = createdRowsSchema.safeParse(await response.json());
    if (!parsed.success) {
      return {
        ok: false,
        message: "The meeting was created but its id could not be read.",
      };
    }
    const row = parsed.data[0];
    if (row === undefined) {
      return { ok: false, message: "The meeting insert returned no row." };
    }
    return { ok: true, meetingId: row.id };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not create the meeting (${reason}).` };
  }
}
