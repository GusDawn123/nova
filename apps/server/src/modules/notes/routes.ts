import {
  followUpDraftSchema,
  followUpToneSchema,
  notesReadResponseSchema,
  regenerateResponseSchema,
  type NotesReadResponse,
} from "@nova/shared";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";

import type { NotesJobStore } from "../../db/jobs.js";
import { requireAuth } from "../../plugins/auth.js";
import { AllProvidersFailedError, LlmError } from "../llm/index.js";

import type { FollowUpInput, FollowUpResult } from "./follow-up.js";
import type { FollowUpWriter, NotesLogger, NotesReader } from "./ports.js";

/**
 * The authed notes REST surface (adr-0006 §REST-surface). Three routes, all behind
 * `requireAuth`, all user-scoped through the injected seams:
 *
 *   GET  /meetings/:id/notes            → 200 read model | uniform 404
 *   POST /meetings/:id/notes/regenerate → 202 queued | 409 already_running | 404
 *   POST /meetings/:id/follow-up {tone} → 200 draft | 409 notes_not_ready | 404 | 503
 *
 * A missing, foreign, or soft-deleted meeting ALL answer a uniform 404 (the reader
 * returns null for each — no existence leak). Every request param/body AND response
 * is zod-parsed (RULES §1); wire-visible shapes are shared schemas (`@nova/shared`).
 * The follow-up call is synchronous; a transport failure maps to a typed 503, never a
 * 500 stack leak. Regeneration is always a queued job (the durable store).
 */

/** Dependencies — injected so the suite drives real DB seams + a mock-router follow-up. */
export interface NotesRoutesDeps {
  readonly reader: NotesReader;
  readonly followUpWriter: FollowUpWriter;
  readonly store: NotesJobStore;
  /** The follow-up runner (cites notes by construction — {@link FollowUpInput}). */
  readonly followUp: (input: FollowUpInput) => Promise<FollowUpResult>;
  readonly logger: NotesLogger;
  /** Injected clock for the stored `generated_at` (deterministic in tests). */
  readonly now?: () => Date;
}

/** Uniform not-found body — a deleted/foreign/unknown meeting is indistinguishable. */
const NOT_FOUND = { error: "not_found" } as const;
/** Path param: the meeting id must be a uuid; anything else is a uniform 404. */
const paramsSchema = z.object({ id: z.string().uuid() });
/** POST /follow-up body — module-local (the request shape is a thin `{tone}`). */
const followUpBodySchema = z.object({ tone: followUpToneSchema });

/** The authenticated caller's id (requireAuth guarantees `request.user` is set). */
function userIdOf(request: FastifyRequest): string {
  const user = request.user;
  if (user === undefined) {
    // Unreachable: requireAuth either populated user or already replied.
    throw new Error("requireAuth did not populate request.user");
  }
  return user.id;
}

/** Parse `:id`; reply a uniform 404 and return null when it is not a uuid. */
async function parseMeetingId(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<string | null> {
  const parsed = paramsSchema.safeParse(request.params);
  if (!parsed.success) {
    await reply.code(404).send(NOT_FOUND);
    return null;
  }
  return parsed.data.id;
}

/** Register the notes REST surface on `app` (mounts under the app's root). */
export function createNotesRoutes(
  deps: NotesRoutesDeps,
): (app: FastifyInstance) => Promise<void> {
  const { reader, followUpWriter, store, followUp, logger } = deps;
  const now = deps.now ?? ((): Date => new Date());

  // eslint-disable-next-line @typescript-eslint/require-await
  return async function notesRoutes(app: FastifyInstance): Promise<void> {
    app.get(
      "/meetings/:id/notes",
      { preHandler: requireAuth },
      async (request, reply): Promise<FastifyReply> => {
        const meetingId = await parseMeetingId(request, reply);
        if (meetingId === null) return reply;

        const model = await reader.readNotes(meetingId, userIdOf(request));
        if (model === null) return reply.code(404).send(NOT_FOUND);

        const body: NotesReadResponse = notesReadResponseSchema.parse({
          notes_status: model.notesStatus,
          notes: model.notes,
          follow_up: model.followUp,
          notes_generated_at: model.notesGeneratedAt,
        });
        return reply.code(200).send(body);
      },
    );

    app.post(
      "/meetings/:id/notes/regenerate",
      { preHandler: requireAuth },
      async (request, reply): Promise<FastifyReply> => {
        const meetingId = await parseMeetingId(request, reply);
        if (meetingId === null) return reply;
        const userId = userIdOf(request);

        // Ownership/existence guard first — a foreign/deleted/unknown meeting 404s
        // uniformly BEFORE we ever enqueue a job for it.
        const model = await reader.readNotes(meetingId, userId);
        if (model === null) return reply.code(404).send(NOT_FOUND);

        if (await store.hasActive(meetingId)) {
          return reply.code(409).send({ error: "already_running" });
        }

        // enqueue also flips notes_status='queued' (store semantics, Task 2). A
        // race that inserted an active job between hasActive and here collides →
        // already_active → the same typed 409.
        const outcome = await store.enqueue(meetingId, userId);
        if (outcome === "already_active") {
          return reply.code(409).send({ error: "already_running" });
        }
        return reply
          .code(202)
          .send(regenerateResponseSchema.parse({ status: "queued" }));
      },
    );

    app.post(
      "/meetings/:id/follow-up",
      { preHandler: requireAuth },
      async (request, reply): Promise<FastifyReply> => {
        const meetingId = await parseMeetingId(request, reply);
        if (meetingId === null) return reply;
        const userId = userIdOf(request);

        const parsedBody = followUpBodySchema.safeParse(request.body);
        if (!parsedBody.success) {
          return reply.code(400).send({ error: "invalid_request" });
        }
        const { tone } = parsedBody.data;

        const model = await reader.readNotes(meetingId, userId);
        if (model === null) return reply.code(404).send(NOT_FOUND);

        // Cites-notes-only requires completed notes to cite (adr §8). No notes yet
        // (or still generating/failed) → typed 409, not a draft from thin air.
        if (model.notes === null || model.notesStatus !== "completed") {
          return reply.code(409).send({ error: "notes_not_ready" });
        }

        let result: FollowUpResult;
        try {
          result = await followUp({
            notes: model.notes,
            tone,
            meetingTitle: model.notes.title,
            // Metering attribution (Phase 6) — ids only, never content.
            userId,
            meetingId,
          });
        } catch (err) {
          // Transport/all-providers failures → typed 503 (never a 500 stack leak).
          if (err instanceof LlmError || err instanceof AllProvidersFailedError) {
            logger.error(
              { user_id: userId, meeting_id: meetingId },
              "notes.follow_up.provider_unavailable",
            );
            return reply.code(503).send({ error: "provider_unavailable" });
          }
          throw err;
        }

        await followUpWriter.writeFollowUp(
          meetingId,
          userId,
          result.draft,
          now(),
        );

        // Per-user follow-up usage line — the Phase 6 metering seam (ids/counts only).
        logger.info(
          {
            user_id: userId,
            meeting_id: meetingId,
            input_tokens: sumTokens(result.usage, "inputTokens"),
            output_tokens: sumTokens(result.usage, "outputTokens"),
            calls: result.usage.length,
          },
          "notes.follow_up.usage",
        );

        return reply.code(200).send(followUpDraftSchema.parse(result.draft));
      },
    );
  };
}

/** Sum one token field across the per-call usage entries (undefined → 0). */
function sumTokens(
  usage: readonly { inputTokens?: number; outputTokens?: number }[],
  field: "inputTokens" | "outputTokens",
): number {
  return usage.reduce((total, entry) => total + (entry[field] ?? 0), 0);
}
