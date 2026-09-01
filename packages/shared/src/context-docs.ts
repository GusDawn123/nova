import { z } from "zod";

/**
 * The knowledge-base wire surface: the reference documents a user uploads so
 * Nova's RAG memory can ground answers in *their* material, not just their
 * calls. Rows live in `context_docs` (soft-deleted, RLS-isolated); chunks live
 * beside meeting chunks under `context_doc_id`.
 */

/** Server-side ceilings, shared so the client can refuse before uploading. */
export const CONTEXT_DOC_MAX_CHARS = 200_000;
export const CONTEXT_DOC_MAX_COUNT = 50;
export const CONTEXT_DOC_TITLE_MAX = 200;

/**
 * One document as the list renders it. `chars` instead of the content itself:
 * the list is a directory, not a reader, and a 200k-character payload per row
 * would tax every open of the settings tab for nothing.
 */
export const contextDocItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  chars: z.number().int().nonnegative(),
  created_at: z.string(),
  /** False = saved but not searchable (yet) — the honest half-state. */
  indexed: z.boolean(),
});
export type ContextDocItem = z.infer<typeof contextDocItemSchema>;

/** `GET /context-docs` 200 body. Newest first. */
export const contextDocsListResponseSchema = z.object({
  docs: z.array(contextDocItemSchema),
});
export type ContextDocsListResponse = z.infer<
  typeof contextDocsListResponseSchema
>;

/** `POST /context-docs` request — plain text in, always. */
export const createContextDocRequestSchema = z
  .object({
    title: z.string().min(1).max(CONTEXT_DOC_TITLE_MAX),
    content: z.string().min(1).max(CONTEXT_DOC_MAX_CHARS),
  })
  .strict();
export type CreateContextDocRequest = z.infer<
  typeof createContextDocRequestSchema
>;

/**
 * `POST /context-docs` 200 body. `note` carries the one sentence worth saying
 * when the doc saved but could not be made searchable — null on the clean path.
 */
export const createContextDocResponseSchema = z.object({
  doc: contextDocItemSchema,
  note: z.string().nullable(),
});
export type CreateContextDocResponse = z.infer<
  typeof createContextDocResponseSchema
>;

/** `DELETE /context-docs/:id` 200 body. */
export const deleteContextDocResponseSchema = z.object({
  status: z.literal("deleted"),
});
export type DeleteContextDocResponse = z.infer<
  typeof deleteContextDocResponseSchema
>;
