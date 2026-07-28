import type { Pool } from "pg";
import { z } from "zod";
import { meetingNotesSchema, type MeetingNotes } from "@nova/shared";

/**
 * `public.live_notes` over a direct `pg` Pool — the only read/write seam for the
 * running-notes PREVIEW accrued during a live call (Phase 8,
 * `docs/DESIGN/live-notes.md` §7). Same house style as `db/usage-events.ts` and
 * `db/jobs.ts`: explicit column lists, positional params, results re-parsed at the
 * boundary.
 *
 * WHY the pg Pool (not supabase-js): the notes conductor folds roughly every 25s,
 * so this is a per-tick write path — ~150 writes on a 60-minute call. The
 * supabase-js REST client used by `db/notes.ts` costs an HTTP round trip per write,
 * which is the wrong tool here. The upsert also needs a `where` clause on the
 * conflict target (the `rev` guard below), which PostgREST cannot express.
 *
 * The pool is INJECTED rather than built from env: this store rides the memoised
 * pool a caller already holds (the `db/plans.ts` / `db/roles.ts` precedent), so
 * there is no fourth `createResilientPool` site and no fourth set of connections
 * against the same database.
 */

// ---------------------------------------------------------------------------
// Boundary parsing (the DB is a boundary too; RULES §1).
//
// Both queries are typed `Record<string, unknown>` rather than a hand-written row
// shape: the schemas below ARE the boundary, and a second structural declaration
// beside them would only drift.
// ---------------------------------------------------------------------------

/**
 * A stored live-notes row.
 *
 * `meetingNotesSchema` (v2), NOT `storedNotesSchema`: unlike `meetings.notes`, this
 * table was born after the v1→v2 split and can never hold a v1 object — every row
 * is written by {@link createLiveNotesStore}, which parses v2 on the way in. The
 * asymmetry with `db/notes.ts` is deliberate, not an oversight.
 *
 * `rev` is `integer` (a JS number over the wire) and `updated_at` is `timestamptz`
 * (a `Date`); both are coerced anyway so a driver-level representation change
 * cannot silently produce a wrong type.
 */
const liveNotesRowSchema = z.object({
  notes: meetingNotesSchema,
  rev: z.coerce.number().int().nonnegative(),
  updated_at: z.coerce.date(),
});

/** Just the `rev` echoed by a successful upsert's `returning`. */
const upsertedRowSchema = z.object({
  rev: z.coerce.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Port.
// ---------------------------------------------------------------------------

/** The stored preview for one meeting, mapped to camelCase at the adapter. */
export interface LiveNotesRow {
  readonly notes: MeetingNotes;
  readonly rev: number;
  /** ISO-8601, matching every other timestamp the REST surface hands out. */
  readonly updatedAt: string;
}

/**
 * The outcome of an upsert. A discriminated union rather than a bare boolean
 * (RULES §10): `stale` is a real state the conductor acts on — it means another
 * writer is ahead, so the in-memory `rev` must be re-hydrated rather than retried —
 * and it must not collapse into an anonymous `false`.
 */
export type LiveNotesWriteResult =
  | { readonly status: "written"; readonly rev: number }
  | { readonly status: "stale" };

/** Input for {@link LiveNotesStore.upsertLiveNotes}. */
export interface LiveNotesUpsertInput {
  readonly meetingId: string;
  readonly userId: string;
  readonly notes: MeetingNotes;
  /** The revision being written. Must exceed the stored one or the write is `stale`. */
  readonly rev: number;
}

/**
 * Read/write seam for `public.live_notes`. Declared here rather than in a module's
 * `ports.ts` because both `modules/notes` (the REST read model) and `modules/live`
 * (the notes conductor, Phase 8 slice 3) consume it — the same reason
 * {@link import("./jobs.js").NotesJobStore} lives in `db/jobs.ts`.
 */
export interface LiveNotesStore {
  /**
   * The meeting's live notes, or null when there are none. User-scoped and
   * `deleted_at`-aware in SQL, so a foreign or tombstoned row is indistinguishable
   * from a missing one (no existence leak, matching `db/notes.ts`).
   */
  readLiveNotes(
    meetingId: string,
    userId: string,
  ): Promise<LiveNotesRow | null>;

  /**
   * Write the preview, guarded by `rev`. Returns `stale` — having written nothing —
   * when the stored revision is already at or past `input.rev`.
   */
  upsertLiveNotes(input: LiveNotesUpsertInput): Promise<LiveNotesWriteResult>;
}

// ---------------------------------------------------------------------------
// Store factory.
// ---------------------------------------------------------------------------

/** Build a {@link LiveNotesStore} over an explicit pool (pure of env). */
export function createLiveNotesStore(pool: Pool): LiveNotesStore {
  return {
    async readLiveNotes(
      meetingId: string,
      userId: string,
    ): Promise<LiveNotesRow | null> {
      // Explicit columns (RULES §10). Scoped by user_id as well as the primary key:
      // the caller has usually already proven ownership, but a store that only
      // trusts its caller is one refactor away from an IDOR.
      const res = await pool.query<Record<string, unknown>>(
        `select notes, rev, updated_at
         from live_notes
         where meeting_id = $1 and user_id = $2 and deleted_at is null`,
        [meetingId, userId],
      );

      const row = res.rows[0];
      if (row === undefined) return null;

      const parsed = liveNotesRowSchema.parse(row);
      return {
        notes: parsed.notes,
        rev: parsed.rev,
        updatedAt: parsed.updated_at.toISOString(),
      };
    },

    async upsertLiveNotes(
      input: LiveNotesUpsertInput,
    ): Promise<LiveNotesWriteResult> {
      // Parse on the way IN as well as out (RULES §1 — "malformed JSON must be
      // unrepresentable in the DB"). `input.notes` is `MeetingNotes` at compile
      // time, but from slice 3 on it originates in an LLM fold, and a compile-time
      // type is not a runtime guarantee.
      const notes = meetingNotesSchema.parse(input.notes);

      // The whole accept/reject decision is this one statement: the `where` on the
      // conflict target makes it an atomic compare-and-set, so no transaction and
      // no read-modify-write race. `deleted_at` is deliberately NOT cleared here —
      // a tombstoned row stays tombstoned rather than being silently resurrected.
      //
      // jsonb is passed as an explicit JSON string rather than leaning on the
      // driver's object→json parameter coercion.
      const res = await pool.query<Record<string, unknown>>(
        `insert into live_notes (meeting_id, user_id, notes, rev, updated_at)
         values ($1, $2, $3, $4, now())
         on conflict (meeting_id) do update
           set notes = excluded.notes,
               rev = excluded.rev,
               updated_at = now()
           where live_notes.rev < excluded.rev
         returning rev`,
        [input.meetingId, input.userId, JSON.stringify(notes), input.rev],
      );

      const row = res.rows[0];
      // Zero rows can only come from the conflict path losing the `rev` guard — a
      // fresh insert always lands.
      if (row === undefined) return { status: "stale" };

      return { status: "written", rev: upsertedRowSchema.parse(row).rev };
    },
  };
}
