import { conversationTypeSchema } from "@nova/shared";
import { z } from "zod";

import type { NoteListKey } from "@nova/shared";

/**
 * The live fold's MODEL CONTRACT (Phase 8, docs/DESIGN/live-notes.md §3): the ops
 * the model is asked to return, and the lenient shapes it is allowed to return
 * them in. Split out of `live-fold.ts` so the reducer file is about the CLAMPS and
 * this one is about what arrives at the door.
 *
 * Leniency here is deliberate and one-directional: accept the several shapes real
 * models emit, then let the reducer and `meetingNotesSchema` decide what is real.
 */

/**
 * Hard ceiling on ops in ONE response. The churn rules below are the real
 * protection; this only stops a runaway/looping response from reaching the
 * reducer at all. A 25s delta cannot legitimately produce this many ops.
 */
export const MAX_OPS_PER_FOLD = 50;

/**
 * `list` and `item` are deliberately LOOSE here. Tightening them (an enum of list
 * keys, a per-list item schema) would make ONE bad op fail the whole parse and
 * burn the ladder's single repair round-trip on an otherwise-good response.
 * Per-op validation happens in {@link applyFold}, which drops the bad op and keeps
 * the rest.
 */
const foldOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"),
    list: z.string().min(1),
    item: z.unknown(),
  }),
  z.object({
    op: z.literal("update"),
    list: z.string().min(1),
    id: z.string().min(1),
    item: z.unknown(),
  }),
  z.object({
    op: z.literal("retract"),
    list: z.string().min(1),
    id: z.string().min(1),
    reason: z.string().optional(),
  }),
]);

/**
 * The structured output one fold asks the model for.
 *
 * `ops` is OPTIONAL rather than defaulted: "nothing new happened" is a perfectly
 * good answer and a bare `{}` must not cost a repair round-trip. It is left
 * optional instead of `.default([])` deliberately — a default makes the schema's
 * input and output types differ, and `runLadder`'s `z.ZodType<T>` parameter then
 * infers the INPUT type, quietly widening every downstream consumer.
 */
export const foldResultSchema = z.object({
  ops: z.array(foldOpSchema).max(MAX_OPS_PER_FOLD).optional(),
  narrative: z
    .object({ title: z.string(), tldr: z.string(), overview: z.string() })
    .partial()
    .optional(),
  conversationType: conversationTypeSchema.optional(),
});
export type FoldResult = z.infer<typeof foldResultSchema>;

// ---------------------------------------------------------------------------
// Inbound item shapes — lenient on purpose
// ---------------------------------------------------------------------------

/**
 * Accepts a bare string OR `{ text }` for the string-valued lists: models emit
 * both shapes for `openQuestions`/`risks` and dropping one of them would silently
 * lose real content. The identified form is minted here, never by the model.
 */
const stringItemInSchema = z.union([
  z.string().min(1).transform((text) => ({ text })),
  z.object({ text: z.string().min(1) }),
]);

/** `quote` defaults to null — a fold that found no verbatim evidence is normal. */
const decisionInSchema = z.object({
  text: z.string().min(1),
  quote: z.string().nullable().default(null),
});

/** Every field but `text` defaults to null (the model states what it heard, only). */
const actionItemInSchema = z.object({
  text: z.string().min(1),
  owner: z.string().nullable().default(null),
  deadline: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  deadlineRaw: z.string().nullable().default(null),
  quote: z.string().nullable().default(null),
});

/** A validated inbound item: `text` is guaranteed, the rest varies by list. */
export type ValidatedItem = { text: string } & Record<string, unknown>;

/** Validate one inbound item for its list; null when the model's payload is junk. */
export function validateItem(
  list: NoteListKey,
  raw: unknown,
): ValidatedItem | null {
  const schema =
    list === "decisions"
      ? decisionInSchema
      : list === "actionItems"
        ? actionItemInSchema
        : stringItemInSchema;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
