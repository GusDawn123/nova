import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  followUpDraftSchema,
  followUpToneSchema,
  notesReadResponseSchema,
  regenerateResponseSchema,
  type NotesReadResponse,
} from "@nova/shared";

import type { NotesJobStore } from "../../db/jobs.js";
import type { LiveNotesStore } from "../../db/live-notes.js";
import type { NoteItemStateStore } from "../../db/note-item-state.js";
import { requireAuth } from "../../plugins/auth.js";
import { AllProvidersFailedError, LlmError } from "../llm/index.js";

import type { FollowUpInput, FollowUpResult } from "./follow-up.js";
import {
  readCompletedIds,
  registerItemCompletionRoute,
} from "./item-completion-routes.js";
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
  /**
   * Request-time llm-token quota gate for the synchronous follow-up call (Phase
   * 6, adr-0007 §4): over → typed 429 `quota_exceeded` (the paywall state)
   * BEFORE any provider call. Optional (keyless posture); fail-open on an
   * internal failure.
   */
  readonly isOverLlmQuota?: (userId: string) => Promise<boolean>;
  /**
   * The global daily-spend kill-switch (Phase 6, adr-0007 §5): tripped → typed
   * 503 `daily_cap_reached` BEFORE any provider call (a service-side stop, not
   * the caller's fault — hence 503, not 429). Optional; fail-open.
   */
  readonly isDailyCapReached?: () => Promise<boolean>;
  /**
   * Read seam for the live running-notes preview (Phase 8,
   * `docs/DESIGN/live-notes.md` §7) — surfaced on GET so a tab opened before the
   * post-call pipeline finishes has cold state to render. Optional (the DB-less
   * boot posture): unwired means `live_notes: null`, never a throw.
   */
  readonly liveNotes?: LiveNotesStore;
  /**
   * Action-item completion state (Phase 8.5, `docs/DESIGN/notes-ui.md` §6.3).
   * Optional for the same DB-less boot posture as {@link liveNotes}: unwired means
   * `completed_item_ids: []` and a 503 from the write route, never a throw.
   */
  readonly noteItemState?: NoteItemStateStore;
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

  // eslint-disable-next-line @typescript-eslint/require-await -- why: Fastify's plugin signature is `(app) => Promise<void>`; registration awaits nothing.
  return async function notesRoutes(app: FastifyInstance): Promise<void> {
    app.get(
      "/meetings/:id/notes",
      { preHandler: requireAuth },
      async (request, reply): Promise<FastifyReply> => {
        const meetingId = await parseMeetingId(request, reply);
        if (meetingId === null) return reply;

        const userId = userIdOf(request);
        const model = await reader.readNotes(meetingId, userId);
        if (model === null) return reply.code(404).send(NOT_FOUND);

        // AFTER the 404 gate: that gate already proved ownership and
        // not-soft-deleted, and this way a 404 costs no second query.
        //
        // BEST-EFFORT, matching the unwired posture and handler.ts's
        // readLivePreview. why: this read used to be unguarded, so a live_notes
        // outage turned a perfectly good notes read into a 500 — the durable
        // payload is the contract here and the live preview is a cosmetic add-on.
        // Absent store and failing store must land in the same place: null.
        let live: Awaited<ReturnType<LiveNotesStore["readLiveNotes"]>> | null =
          null;
        if (deps.liveNotes) {
          try {
            live = await deps.liveNotes.readLiveNotes(meetingId, userId);
          } catch (err: unknown) {
            // Degrading silently would hide a real outage.
            logger.error(
              {
                request_id: request.id,
                user_id: userId,
                meeting_id: meetingId,
                error: err instanceof Error ? err.message : String(err),
              },
              "notes.routes.live_notes_read_failed",
            );
          }
        }

        // Completion is resolved against the notes the client will actually
        // RENDER — post-call when they exist, else the live preview. That is what
        // makes a checkmark made mid-call survive the hangup swap: `reconcileIds`
        // carries the live item's id onto its post-call counterpart, so the stored
        // row still matches by id, and the text guard still matches by similarity
        // even though the post-call pass reworded it.
        const rendered = model.notes ?? live?.notes ?? null;
        const completed = await readCompletedIds(
          deps.noteItemState,
          rendered,
          meetingId,
          userId,
          request.id,
          logger,
        );

        const body: NotesReadResponse = notesReadResponseSchema.parse({
          notes_status: model.notesStatus,
          notes: model.notes,
          follow_up: model.followUp,
          notes_generated_at: model.notesGeneratedAt,
          live_notes: live?.notes ?? null,
          live_notes_rev: live?.rev ?? null,
          completed_item_ids: completed,
        });
        return reply.code(200).send(body);
      },
    );

    // Action-item completion (Phase 8.5). Registered from its own module: both
    // halves of the feature (this write and the read helper the GET composes in)
    // share the take-the-text-from-current-notes rule, and splitting them across
    // files is how that rule drifts. See `item-completion-routes.ts`.
    registerItemCompletionRoute(app, {
      reader,
      logger,
      now,
      ...(deps.noteItemState ? { noteItemState: deps.noteItemState } : {}),
      ...(deps.liveNotes ? { liveNotes: deps.liveNotes } : {}),
    });

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

        // Kill-switch gate (Phase 6, adr-0007 §5) — global/cheap before the
        // per-user quota below. Fail-open (the kill-switch logs loudly itself).
        if (deps.isDailyCapReached) {
          let capReached = false;
          try {
            capReached = await deps.isDailyCapReached();
          } catch (err) {
            logger.error(
              { user_id: userId, meeting_id: meetingId, err },
              "notes.follow_up.daily_cap_check_failed",
            );
          }
          if (capReached) {
            logger.info(
              { user_id: userId, meeting_id: meetingId },
              "notes.follow_up.daily_cap_reached",
            );
            return reply.code(503).send({ error: "daily_cap_reached" });
          }
        }

        // Quota gate (Phase 6, adr-0007 §4) — BEFORE the paid call. Fail-open on
        // an internal failure (logged): quota protects spend, not availability.
        if (deps.isOverLlmQuota) {
          let overQuota = false;
          try {
            overQuota = await deps.isOverLlmQuota(userId);
          } catch (err) {
            logger.error(
              { user_id: userId, meeting_id: meetingId, err },
              "notes.follow_up.quota_check_failed",
            );
          }
          if (overQuota) {
            logger.info(
              { user_id: userId, meeting_id: meetingId },
              "notes.follow_up.quota_exceeded",
            );
            return reply.code(429).send({ error: "quota_exceeded" });
          }
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
          if (
            err instanceof LlmError ||
            err instanceof AllProvidersFailedError
          ) {
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
