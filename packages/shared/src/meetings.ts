import { z } from "zod";

import { conversationTypeSchema, notesStatusSchema } from "./notes.js";

/**
 * Wire models for the meetings surface (Phase 8.5, `docs/DESIGN/notes-ui.md` §6):
 * the list the Meetings screen renders and the turns its Transcript tab shows.
 *
 * Both are PROJECTIONS, deliberately. `meetings.notes` is a jsonb blob holding two
 * schema versions, and the v1→v2 upcast lives on the server (`storedNotesSchema` +
 * `upcastNotesV1`, see `db/notes.ts`). Shipping the raw column to the client would
 * mean every consumer reimplements that upcast or breaks on pre-v2 rows — so the
 * server reads the blob, upcasts it, and sends only the nine fields a card renders.
 * The same argument is why these routes exist at all rather than the app querying
 * PostgREST directly.
 */

/**
 * One row of the Meetings list. Flat and card-shaped: everything here is drawn
 * directly, so the client holds no notes-schema knowledge and does no digging.
 */
export const meetingListItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  /** Call start; null for a meeting created but never connected. */
  started_at: z.string().nullable(),
  /** Call end; null while live, or if the call never ended cleanly. */
  ended_at: z.string().nullable(),
  notes_status: notesStatusSchema,
  /**
   * The card's one-line summary: the post-call `notes.tldr` when generation has
   * finished, else the LIVE notes' tldr so a still-folding call shows something
   * real instead of an empty line, else null.
   */
  tldr: z.string().nullable(),
  /** Drives the type chip and the list filter; null until notes exist. */
  conversation_type: conversationTypeSchema.nullable(),
  /** Count only — the items themselves live behind the detail screen. */
  action_item_count: z.number().int().nonnegative(),
  /** Whether a follow-up draft has been generated (the "follow-up drafted" chip). */
  has_follow_up: z.boolean(),
});
export type MeetingListItem = z.infer<typeof meetingListItemSchema>;

/** `GET /meetings` 200 body. */
export const meetingListResponseSchema = z.object({
  /**
   * Newest first (`started_at desc nulls last, created_at desc`), soft-deleted rows
   * excluded, capped server-side. The cap is logged when it truncates — a silently
   * truncated list reads as "you have no older meetings", which is a lie.
   */
  meetings: z.array(meetingListItemSchema),
  /** Calls started in the current UTC month — the list header's counter. */
  month_count: z.number().int().nonnegative(),
});
export type MeetingListResponse = z.infer<typeof meetingListResponseSchema>;

/**
 * One transcript turn as the Transcript tab renders it. Named for the meetings
 * surface to stay clear of `modules/notes`' internal `TranscriptTurn`, which is the
 * pipeline's input shape rather than a wire model.
 */
export const meetingTranscriptTurnSchema = z.object({
  /** The diarized speaker label; null when the vendor gave none. */
  speaker: z.string().nullable(),
  /** Call-relative offset in ms, rendered `mm:ss`; null when unknown. */
  ts_ms: z.number().int().nonnegative().nullable(),
  content: z.string().min(1),
});
export type MeetingTranscriptTurn = z.infer<typeof meetingTranscriptTurnSchema>;

/**
 * `GET /meetings/:id/transcript` 200 body. Separate from the notes read on purpose:
 * notes is polled while a call folds, transcripts are opened on demand and can be
 * long, so the tab loads them lazily instead of inflating every notes read.
 */
export const meetingTranscriptResponseSchema = z.object({
  /** Ordered `ts_ms asc nulls last, created_at asc`. Empty is legitimate. */
  turns: z.array(meetingTranscriptTurnSchema),
});
export type MeetingTranscriptResponse = z.infer<
  typeof meetingTranscriptResponseSchema
>;
