import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { noteIdSchema, type MeetingNotes } from "@nova/shared";

import type { NoteItemStateStore } from "../../db/note-item-state.js";
import { requireAuth } from "../../plugins/auth.js";

import { completedItemIds } from "./item-completion.js";
import type { NotesLogger, NotesReader } from "./ports.js";
import { userIdOf } from "./route-helpers.js";

/**
 * The action-item completion surface (Phase 8.5, `docs/DESIGN/notes-ui.md` §6.3),
 * split out of `routes.ts` when that file passed the ~400-line cap (RULES §2).
 *
 * Both halves of the feature live here — the WRITE (`PUT
 * /meetings/:id/notes/items/:itemId`) and the READ helper the notes GET composes in.
 * They share one non-obvious rule, and keeping them apart is how that rule drifts:
 * the item's text is taken from the CURRENT NOTES on both paths, never from the
 * request, because it is the staleness guard's only anchor.
 */

/** Uniform not-found body — identical for deleted/foreign/unknown/absent-item. */
const NOT_FOUND = { error: "not_found" } as const;

/**
 * PUT params. `itemId` is validated against the note-id grammar here and against
 * the meeting's ACTUAL notes in the handler — the shape check just keeps obvious
 * junk out of a DB round trip.
 */
const itemParamsSchema = z.object({
  id: z.string().uuid(),
  itemId: noteIdSchema,
});

/** PUT body — a bare toggle; the item's text is never client-supplied. */
const itemCompletionBodySchema = z.object({ completed: z.boolean() });

/** PUT 200 body — echoes what was recorded so an optimistic client can settle. */
export const itemCompletionResponseSchema = z.object({
  item_id: noteIdSchema,
  completed: z.boolean(),
});

/** What the completion routes need from the enclosing notes surface. */
export interface ItemCompletionDeps {
  readonly reader: NotesReader;
  readonly logger: NotesLogger;
  readonly now: () => Date;
  readonly noteItemState?: NoteItemStateStore;
}

/**
 * Resolve the checked ids for the notes about to be rendered.
 *
 * BEST-EFFORT: completion is an accent on a checkbox, and an outage in this table
 * must not turn a perfectly good notes read into a 500. Absent store and failing
 * store both land on `[]` — unchecked, which is the safe direction: the user sees
 * their task as outstanding rather than being told they finished something they
 * did not.
 */
export async function readCompletedIds(
  store: NoteItemStateStore | undefined,
  rendered: MeetingNotes | null,
  meetingId: string,
  userId: string,
  requestId: string,
  logger: NotesLogger,
): Promise<string[]> {
  if (!store || rendered === null) return [];
  try {
    const stored = await store.readForMeeting(meetingId, userId);
    return completedItemIds(rendered, stored);
  } catch (err: unknown) {
    // Degrading silently would hide a real outage.
    logger.error(
      {
        request_id: requestId,
        user_id: userId,
        meeting_id: meetingId,
        error: err instanceof Error ? err.message : String(err),
      },
      "notes.routes.item_completion_read_failed",
    );
    return [];
  }
}

/**
 * READ the notes a completion decision is made against — the same notes the GET
 * renders, so the client can only ever check an item it is looking at.
 */
async function renderedNotes(
  deps: ItemCompletionDeps,
  meetingId: string,
  userId: string,
): Promise<MeetingNotes | null> {
  const model = await deps.reader.readNotes(meetingId, userId);
  return model?.notes ?? null;
}

/**
 * Register `PUT /meetings/:id/notes/items/:itemId` on an already-scoped app.
 *
 * The meeting-existence check happens through {@link renderedNotes}, which reads
 * the notes model — so a missing, foreign, or soft-deleted meeting and an item id
 * that is not in the notes all answer the SAME uniform 404. That is deliberate: the
 * set of item ids a meeting has is as much a leak as the meeting's existence.
 */
export function registerItemCompletionRoute(
  app: FastifyInstance,
  deps: ItemCompletionDeps,
): void {
  app.put(
    "/meetings/:id/notes/items/:itemId",
    { preHandler: requireAuth },
    async (request, reply): Promise<FastifyReply> => {
      const params = itemParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(404).send(NOT_FOUND);

      const userId = userIdOf(request);
      const meetingId = params.data.id;

      const store = deps.noteItemState;
      // Unwired (the DB-less boot posture) — a typed 503, never a 500. The GET
      // degrades to an empty array; a WRITE must not degrade silently, because
      // silently dropping it IS the unchecks-itself-on-refresh bug this whole
      // feature exists to prevent.
      if (!store) {
        return reply.code(503).send({ error: "completion_unavailable" });
      }

      const body = itemCompletionBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }

      const rendered = await renderedNotes(deps, meetingId, userId);
      if (rendered === null) return reply.code(404).send(NOT_FOUND);

      // The item must exist AND be an action item. Taking the text from here
      // rather than from the request is the entire guard: a client cannot seed
      // `item_text` with something that was never in the notes and thereby pin a
      // stale checkmark on forever.
      const item = rendered.actionItems.find(
        (candidate) => candidate.id === params.data.itemId,
      );
      if (item === undefined) return reply.code(404).send(NOT_FOUND);

      await store.setCompleted({
        meetingId,
        userId,
        itemId: item.id,
        itemText: item.text,
        completed: body.data.completed,
        now: deps.now(),
      });

      return reply.code(200).send(
        itemCompletionResponseSchema.parse({
          item_id: item.id,
          completed: body.data.completed,
        }),
      );
    },
  );
}
