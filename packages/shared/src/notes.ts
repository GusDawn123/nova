import { z } from "zod";

/**
 * Post-call notes contract (Phase 5) — the shared wire schema the notes pipeline
 * produces, the DB stores in `meetings.notes` (jsonb), the REST surface returns,
 * and the mobile app renders (Phase 8). Design source:
 * `docs/DESIGN/notes-pipeline.md` §The notes contract +
 * `docs/DECISIONS/adr-0006-notes-pipeline.md` §7.
 *
 * INVARIANT (RULES §1): `meetings.notes` is ONLY ever a `meetingNotesSchema`-valid
 * object — the output ladder (salvage → zod → repair → fallback) guarantees it, so
 * malformed LLM JSON is unrepresentable in the DB. `buildFallbackNotes` is the
 * ladder's last rung: a deterministic, always-valid constant (proven by unit test)
 * so generation can never leave a meeting without notes.
 *
 * VERSIONING: `version: 1` is stamped on every notes object; a future breaking
 * change bumps the literal so a stale reader fails the parse rather than
 * mis-reading fields (same discipline as the live wire protocol).
 */

/** The conversation shape the pipeline classifies a call into; selects the prompt + insights arm. */
export const conversationTypeSchema = z.enum(["sales", "interview", "casual"]);
export type ConversationType = z.infer<typeof conversationTypeSchema>;

/**
 * A decision reached in the call. `quote` is the verbatim transcript evidence
 * (null when none); `unverified` is set (only ever `true`) when that quote failed
 * substring verification — the item is kept for recall, flagged for observability.
 */
export const noteDecisionSchema = z.object({
  text: z.string().min(1),
  quote: z.string().nullable(),
  unverified: z.literal(true).optional(),
});
export type NoteDecision = z.infer<typeof noteDecisionSchema>;

/**
 * A committed action item. `owner` comes from diarized labels/named speakers only
 * (never invented); `deadline` is an ISO calendar date and `deadlineRaw` its
 * verbatim source phrase — BOTH null when the call stated no date (the model never
 * invents one). `unverified` flags a failed quote check (kept, not dropped).
 */
export const noteActionItemSchema = z.object({
  text: z.string().min(1),
  owner: z.string().nullable(),
  // ISO calendar date (`YYYY-MM-DD`); null when no date was stated in the call.
  deadline: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  deadlineRaw: z.string().nullable(),
  quote: z.string().nullable(),
  unverified: z.literal(true).optional(),
});
export type NoteActionItem = z.infer<typeof noteActionItemSchema>;

/**
 * The type-specific section — the SHAPE difference between conversation types.
 * Discriminated on `kind` so a consumer's exhaustive switch breaks the build when a
 * new arm is added; `casual` carries no extra section.
 */
export const typeInsightsSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sales"),
    objections: z.array(z.string()),
    buyingSignals: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("interview"),
    questionsAsked: z.array(z.string()),
    answersToRevisit: z.array(z.string()),
  }),
  z.object({ kind: z.literal("casual") }),
]);
export type TypeInsights = z.infer<typeof typeInsightsSchema>;

/**
 * The full notes object stored on a meeting. `.strict()` rejects unknown top-level
 * keys so a model that pads the object with extra fields fails the parse (RULES §1
 * — LLM output is hostile input; unmodelled keys are a smell, not silently kept).
 * `source` lets the UI key a retry affordance off `'fallback'`.
 */
export const meetingNotesSchema = z
  .object({
    version: z.literal(1),
    conversationType: conversationTypeSchema,
    title: z.string().min(1),
    tldr: z.string().min(1),
    overview: z.string().min(1),
    decisions: z.array(noteDecisionSchema),
    actionItems: z.array(noteActionItemSchema),
    openQuestions: z.array(z.string()),
    risks: z.array(z.string()),
    typeInsights: typeInsightsSchema,
    source: z.enum(["generated", "fallback"]),
  })
  .strict();
export type MeetingNotes = z.infer<typeof meetingNotesSchema>;

/** Tone of a generated follow-up draft. */
export const followUpToneSchema = z.enum(["professional", "warm", "brief"]);
export type FollowUpTone = z.infer<typeof followUpToneSchema>;

/**
 * A copy-ready follow-up email, generated FROM the validated notes object only
 * (never the raw transcript — cites-notes-only holds by construction).
 */
export const followUpDraftSchema = z.object({
  tone: followUpToneSchema,
  subject: z.string().min(1),
  body: z.string().min(1),
});
export type FollowUpDraft = z.infer<typeof followUpDraftSchema>;

/** The tldr the deterministic fallback always carries; the UI can surface a retry. */
export const FALLBACK_TLDR =
  "Automatic notes are unavailable for this call." as const;

/**
 * The output ladder's last rung: a deterministic, always `meetingNotesSchema`-valid
 * notes object (empty arrays, `typeInsights: {kind:'casual'}`, `source:'fallback'`).
 * A fallback still COMPLETES the job (`notes_status='completed'`); the UI keys a
 * retry affordance off `source`.
 *
 * `title` is coalesced to a safe default when blank: `meetings.title` is `not null`
 * but not length-checked, so an empty title would otherwise break the schema's
 * `min(1)` — the guard is what makes "the fallback can never fail" literally true.
 */
export function buildFallbackNotes(title: string): MeetingNotes {
  const safeTitle = title.trim() === "" ? "Untitled call" : title;
  return {
    version: 1,
    conversationType: "casual",
    title: safeTitle,
    tldr: FALLBACK_TLDR,
    overview: FALLBACK_TLDR,
    decisions: [],
    actionItems: [],
    openQuestions: [],
    risks: [],
    typeInsights: { kind: "casual" },
    source: "fallback",
  };
}
