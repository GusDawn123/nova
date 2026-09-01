import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  contextDocsListResponseSchema,
  createContextDocRequestSchema,
  createContextDocResponseSchema,
  deleteContextDocResponseSchema,
  CONTEXT_DOC_MAX_COUNT,
  type ContextDocItem,
  type ContextDocsListResponse,
  type CreateContextDocResponse,
} from "@nova/shared";

import type { ContextDocRow, ContextDocsStore } from "../../db/context-docs.js";
import { requireAuth } from "../../plugins/auth.js";
import { isRagError, type RagService } from "../rag/index.js";

/**
 * The knowledge-base REST surface: the reference documents a user uploads so
 * RAG grounding can draw on their material. Three routes, all behind
 * `requireAuth`, all user-scoped through the injected store:
 *
 *   GET    /context-docs      → 200 list
 *   POST   /context-docs      → 200 saved (indexed when RAG is configured) | 409 doc_limit
 *   DELETE /context-docs/:id  → 200 deleted | uniform 404
 *
 * Indexing is best-effort by design: the row is the source of truth and always
 * saves; the chunks are derived. A boot without an embedder (or an embed that
 * fails) still stores the doc and SAYS it is not searchable — `indexed: false`
 * plus a sentence — because a silent half-success reads exactly like a full one.
 * Deleting re-ingests the source with empty content, which is the store's
 * idempotent way to retire every chunk, then soft-deletes the row (RULES §3).
 */

export interface ContextDocsRoutesDeps {
  readonly store: ContextDocsStore;
  /** Absent on a boot with no embedder — uploads then save unindexed. */
  readonly rag: RagService | null;
  readonly logger: {
    error(payload: Record<string, unknown>, message: string): void;
  };
  readonly maxDocs?: number;
}

const NOT_FOUND = { error: "not_found" } as const;
const INTERNAL = { error: "internal" } as const;
const DOC_LIMIT = { error: "doc_limit" } as const;

const paramsSchema = z.object({ id: z.string().uuid() });

const NOT_SEARCHABLE =
  "Saved, but not searchable yet — document indexing is not available right now.";

function userIdOf(request: FastifyRequest): string {
  const user = request.user;
  if (user === undefined) {
    // Unreachable: requireAuth either populated user or already replied.
    throw new Error("requireAuth did not populate request.user");
  }
  return user.id;
}

function toItem(row: ContextDocRow): ContextDocItem {
  return {
    id: row.id,
    title: row.title,
    chars: row.content.length,
    created_at: row.created_at,
    indexed: row.indexed_at !== null,
  };
}

/** Register the knowledge-base surface on `app` (mounts under the app's root). */
export function createContextDocsRoutes(
  deps: ContextDocsRoutesDeps,
): (app: FastifyInstance) => Promise<void> {
  const { store, rag, logger } = deps;
  const maxDocs = deps.maxDocs ?? CONTEXT_DOC_MAX_COUNT;

  // eslint-disable-next-line @typescript-eslint/require-await -- why: Fastify's plugin signature is `(app) => Promise<void>`; registration awaits nothing.
  return async function contextDocsRoutes(app: FastifyInstance): Promise<void> {
    app.get(
      "/context-docs",
      { preHandler: requireAuth },
      async (request, reply): Promise<FastifyReply> => {
        const userId = userIdOf(request);
        try {
          const rows = await store.list(userId, maxDocs);
          const body: ContextDocsListResponse =
            contextDocsListResponseSchema.parse({ docs: rows.map(toItem) });
          return await reply.code(200).send(body);
        } catch (err: unknown) {
          logger.error(
            {
              request_id: request.id,
              user_id: userId,
              error: err instanceof Error ? err.message : String(err),
            },
            "context_docs.list.read_failed",
          );
          return reply.code(500).send(INTERNAL);
        }
      },
    );

    app.post(
      "/context-docs",
      { preHandler: requireAuth },
      async (request, reply): Promise<FastifyReply> => {
        const userId = userIdOf(request);
        const parsed = createContextDocRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: "invalid_request" });
        }

        try {
          if ((await store.countLive(userId)) >= maxDocs) {
            return await reply.code(409).send(DOC_LIMIT);
          }

          const row = await store.create(
            userId,
            parsed.data.title,
            parsed.data.content,
          );

          // Best-effort indexing: a failure here downgrades the answer, never
          // the row. SOURCE_TOO_LARGE and friends arrive as RagErrors with
          // their own words; anything else logs and reads "not searchable".
          let indexed = false;
          let note: string | null = rag === null ? NOT_SEARCHABLE : null;
          if (rag !== null) {
            try {
              await rag.ingest(userId, {
                kind: "context_doc",
                contextDocId: row.id,
                title: row.title,
                content: row.content,
              });
              await store.stampIndexed(userId, row.id);
              indexed = true;
            } catch (err: unknown) {
              note = isRagError(err) ? err.message : NOT_SEARCHABLE;
              logger.error(
                {
                  request_id: request.id,
                  user_id: userId,
                  doc_id: row.id,
                  error: err instanceof Error ? err.message : String(err),
                },
                "context_docs.create.index_failed",
              );
            }
          }

          const body: CreateContextDocResponse =
            createContextDocResponseSchema.parse({
              doc: { ...toItem(row), indexed },
              note,
            });
          return await reply.code(200).send(body);
        } catch (err: unknown) {
          logger.error(
            {
              request_id: request.id,
              user_id: userId,
              error: err instanceof Error ? err.message : String(err),
            },
            "context_docs.create.failed",
          );
          return reply.code(500).send(INTERNAL);
        }
      },
    );

    app.delete(
      "/context-docs/:id",
      { preHandler: requireAuth },
      async (request, reply): Promise<FastifyReply> => {
        const userId = userIdOf(request);
        const params = paramsSchema.safeParse(request.params);
        if (!params.success) {
          // A non-uuid `:id` is a uniform 404, never a 400 — no existence leak.
          return reply.code(404).send(NOT_FOUND);
        }

        try {
          const row = await store.find(userId, params.data.id);
          if (row === null) {
            return await reply.code(404).send(NOT_FOUND);
          }

          // Chunks first, row second: a crash between the two leaves a doc that
          // still lists (and can be deleted again), never orphaned chunks that
          // keep grounding answers in a document the user removed.
          if (rag !== null) {
            await rag.ingest(userId, {
              kind: "context_doc",
              contextDocId: row.id,
              title: row.title,
              content: "",
            });
          }
          await store.softDelete(userId, row.id);

          return await reply
            .code(200)
            .send(deleteContextDocResponseSchema.parse({ status: "deleted" }));
        } catch (err: unknown) {
          logger.error(
            {
              request_id: request.id,
              user_id: userId,
              doc_id: params.data.id,
              error: err instanceof Error ? err.message : String(err),
            },
            "context_docs.delete.failed",
          );
          return reply.code(500).send(INTERNAL);
        }
      },
    );
  };
}
