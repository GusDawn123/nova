import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  meetingListResponseSchema,
  meetingTranscriptResponseSchema,
  type MeetingListResponse,
  type MeetingTranscriptResponse,
} from "@nova/shared";

import { requireAuth } from "../../plugins/auth.js";

import type { MeetingsLogger, MeetingsReader } from "./ports.js";
import { toListItems } from "./project.js";

/**
 * The authed meetings read surface (Phase 8.5, `docs/DESIGN/notes-ui.md` §6). Two
 * routes, both behind `requireAuth`, both user-scoped through the injected reader:
 *
 *   GET /meetings                  → 200 list model
 *   GET /meetings/:id/transcript   → 200 turns | uniform 404
 *
 * These sit beside the notes routes (`modules/notes/routes.ts`) and follow the same
 * contract: a missing, foreign, or soft-deleted meeting all answer an identical 404
 * with no existence leak, every param is zod-parsed, and every response is parsed
 * against the shared wire schema on the way out (RULES §1).
 *
 * Unlike the notes routes these need NO llm provider — only the database — so they
 * register on any DB-configured boot, including one with no vendor keys at all.
 */

/** Dependencies — injected so the suite can drive real DB seams. */
export interface MeetingsRoutesDeps {
  readonly reader: MeetingsReader;
  readonly logger: MeetingsLogger;
  /**
   * Page size for `GET /meetings`. Paging is not built yet; this is the honest
   * ceiling until it is, and hitting it is LOGGED rather than silently truncating
   * (a cut-off list otherwise reads as "you have no older meetings").
   */
  readonly listLimit?: number;
  /** Injected clock so the month counter is deterministic under test. */
  readonly now?: () => Date;
}

/** Default page size. Generous for a personal call history; revisit with paging. */
export const DEFAULT_LIST_LIMIT = 100;

/** Uniform not-found body — identical for deleted/foreign/unknown meetings. */
const NOT_FOUND = { error: "not_found" } as const;
/**
 * Uniform failure body. why: an unhandled throw reaches Fastify's default error
 * handler, which serialises `error.message` to the client — and every message this
 * reader throws is a DB error string ("listMeetings failed: …"). A read outage must
 * say nothing more than that it failed; the detail belongs in the logs.
 */
const INTERNAL = { error: "internal" } as const;
/** Path param: a non-uuid `:id` is a uniform 404, never a 400. */
const paramsSchema = z.object({ id: z.string().uuid() });

/** The authenticated caller's id (requireAuth guarantees `request.user` is set). */
function userIdOf(request: FastifyRequest): string {
  const user = request.user;
  if (user === undefined) {
    // Unreachable: requireAuth either populated user or already replied.
    throw new Error("requireAuth did not populate request.user");
  }
  return user.id;
}

/** First instant of the current UTC month — the month counter's lower bound. */
function startOfUtcMonth(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );
}

/** Register the meetings read surface on `app` (mounts under the app's root). */
export function createMeetingsRoutes(
  deps: MeetingsRoutesDeps,
): (app: FastifyInstance) => Promise<void> {
  const { reader, logger } = deps;
  const listLimit = deps.listLimit ?? DEFAULT_LIST_LIMIT;
  const now = deps.now ?? ((): Date => new Date());

  // eslint-disable-next-line @typescript-eslint/require-await -- why: Fastify's plugin signature is `(app) => Promise<void>`; registration awaits nothing.
  return async function meetingsRoutes(app: FastifyInstance): Promise<void> {
    app.get(
      "/meetings",
      { preHandler: requireAuth },
      async (request, reply): Promise<FastifyReply> => {
        const userId = userIdOf(request);

        let rows: Awaited<ReturnType<MeetingsReader["listMeetings"]>>;
        let monthCount: number;
        try {
          [rows, monthCount] = await Promise.all([
            reader.listMeetings(userId, listLimit),
            reader.countMeetingsSince(userId, startOfUtcMonth(now())),
          ]);
        } catch (err: unknown) {
          logger.error(
            {
              request_id: request.id,
              user_id: userId,
              error: err instanceof Error ? err.message : String(err),
            },
            "meetings.list.read_failed",
          );
          return reply.code(500).send(INTERNAL);
        }

        // A full page means there are probably more. Say so in the logs; the
        // response cannot say it until paging exists, and pretending the list is
        // complete is the failure mode worth naming.
        if (rows.length === listLimit) {
          logger.info(
            {
              request_id: request.id,
              user_id: userId,
              limit: listLimit,
            },
            "meetings.list.truncated",
          );
        }

        const body: MeetingListResponse = meetingListResponseSchema.parse({
          meetings: toListItems(rows),
          month_count: monthCount,
        });
        return reply.code(200).send(body);
      },
    );

    app.get(
      "/meetings/:id/transcript",
      { preHandler: requireAuth },
      async (request, reply): Promise<FastifyReply> => {
        const parsed = paramsSchema.safeParse(request.params);
        if (!parsed.success) return reply.code(404).send(NOT_FOUND);
        const meetingId = parsed.data.id;
        const userId = userIdOf(request);

        let turns: Awaited<ReturnType<MeetingsReader["readTranscript"]>>;
        try {
          turns = await reader.readTranscript(meetingId, userId);
        } catch (err: unknown) {
          logger.error(
            {
              request_id: request.id,
              user_id: userId,
              meeting_id: meetingId,
              error: err instanceof Error ? err.message : String(err),
            },
            "meetings.transcript.read_failed",
          );
          return reply.code(500).send(INTERNAL);
        }
        // null = missing/foreign/deleted. An EMPTY ARRAY is a real answer and must
        // reach the client as 200 `{turns: []}` — a call that has not spoken yet.
        if (turns === null) return reply.code(404).send(NOT_FOUND);

        const body: MeetingTranscriptResponse =
          meetingTranscriptResponseSchema.parse({ turns });
        return reply.code(200).send(body);
      },
    );
  };
}
