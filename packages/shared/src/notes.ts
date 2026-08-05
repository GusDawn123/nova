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
 * ── v2 (2026-07-25, live notes — docs/DESIGN/live-notes.md §2) ───────────────
 * The contract is split in two so the SAME shape serves the streaming preview and
 * the post-call final, without disturbing the post-call model contract:
 *
 *   {@link notesContentSchema}  id-LESS. Exactly the v1 body. This is what the
 *                               post-call LLM is asked for, so NO post-call prompt
 *                               changes and the accuracy gates are untouched.
 *   {@link meetingNotesSchema}  v2, IDENTIFIED. What is stored, read, and sent down
 *                               the live socket. Every itemized entry carries a
 *                               server-minted `id` so the mobile client can diff by
 *                               identity and animate add/update/retract rather than
 *                               re-rendering the whole object.
 *
 * {@link identifyNotes} is the pure bridge between them (ids are minted in CODE at
 * assembly — never asked of the model, which is hostile input per RULES §1).
 *
 * VERSIONING: `version` is stamped on every notes object. v2 is what every writer
 * emits; {@link storedNotesSchema} is the READ boundary and accepts v1 ∪ v2,
 * upcasting v1 in place. That is what keeps meetings generated before v2 readable —
 * a bare literal bump would make every pre-v2 row throw on parse and answer 500 for
 * the life of the meeting (both `db/notes.ts` and `db/schema.ts` parse this column).
 */

/** The conversation shape the pipeline classifies a call into; selects the prompt + insights arm. */
export const conversationTypeSchema = z.enum(["sales", "interview", "casual"]);
export type ConversationType = z.infer<typeof conversationTypeSchema>;

/**
 * A stable, server-minted item id: a short list prefix plus a 1-based counter
 * (`d1` decisions, `a1` action items, `q1` open questions, `r1` risks, `ob1`/`bs1`
 * sales arms, `qa1`/`ar1` interview arms). Deliberately tiny — it round-trips
 * through the live-fold prompt on every tick, and it is echoed back by the model,
 * so every byte is paid for repeatedly.
 */
export const noteIdSchema = z.string().regex(/^[a-z]{1,2}\d+$/);

/** The id prefix owned by each itemized list. Shared with the live fold's reducer. */
export const NOTE_ID_PREFIX = {
  decisions: "d",
  actionItems: "a",
  openQuestions: "q",
  risks: "r",
  objections: "ob",
  buyingSignals: "bs",
  questionsAsked: "qa",
  answersToRevisit: "ar",
} as const;

export type NoteListKey = keyof typeof NOTE_ID_PREFIX;

// ---------------------------------------------------------------------------
// Content shapes — id-less; the post-call LLM contract (v1 body, verbatim)
// ---------------------------------------------------------------------------

/**
 * A decision reached in the call. `quote` is the verbatim transcript evidence
 * (null when none); `unverified` is set (only ever `true`) when that quote failed
 * substring verification — the item is kept for recall, flagged for observability.
 */
export const noteDecisionContentSchema = z.object({
  text: z.string().min(1),
  quote: z.string().nullable(),
  unverified: z.literal(true).optional(),
});
export type NoteDecisionContent = z.infer<typeof noteDecisionContentSchema>;

/**
 * A committed action item. `owner` comes from diarized labels/named speakers only
 * (never invented); `deadline` is an ISO calendar date and `deadlineRaw` its
 * verbatim source phrase — BOTH null when the call stated no date (the model never
 * invents one). `unverified` flags a failed quote check (kept, not dropped).
 */
export const noteActionItemContentSchema = z.object({
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
export type NoteActionItemContent = z.infer<typeof noteActionItemContentSchema>;

/**
 * The type-specific section — the SHAPE difference between conversation types.
 * Discriminated on `kind` so a consumer's exhaustive switch breaks the build when a
 * new arm is added; `casual` carries no extra section.
 */
export const typeInsightsContentSchema = z.discriminatedUnion("kind", [
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
export type TypeInsightsContent = z.infer<typeof typeInsightsContentSchema>;

/**
 * The id-less notes body — what the post-call model is asked to produce (the
 * pipeline's ladder validates against this, then {@link identifyNotes} stamps
 * `version`/`source` and mints ids). `.strict()` rejects unknown keys so a model
 * that pads the object fails the parse (RULES §1 — LLM output is hostile input).
 */
export const notesContentSchema = z
  .object({
    conversationType: conversationTypeSchema,
    title: z.string().min(1),
    tldr: z.string().min(1),
    overview: z.string().min(1),
    decisions: z.array(noteDecisionContentSchema),
    actionItems: z.array(noteActionItemContentSchema),
    openQuestions: z.array(z.string()),
    risks: z.array(z.string()),
    typeInsights: typeInsightsContentSchema,
  })
  .strict();
export type NotesContent = z.infer<typeof notesContentSchema>;

// ---------------------------------------------------------------------------
// Identified shapes — v2; what is stored, read, and sent on the wire
// ---------------------------------------------------------------------------

/** A decision with its stable id. */
export const noteDecisionSchema = noteDecisionContentSchema.extend({
  id: noteIdSchema,
});
export type NoteDecision = z.infer<typeof noteDecisionSchema>;

/** An action item with its stable id. */
export const noteActionItemSchema = noteActionItemContentSchema.extend({
  id: noteIdSchema,
});
export type NoteActionItem = z.infer<typeof noteActionItemSchema>;

/**
 * The identified form of a plain-string list entry (`openQuestions`, `risks`, and
 * the insight arms). v1 held these as bare strings; v2 promotes them so EVERY list
 * animates by identity, not just the two that were already objects.
 */
export const noteStringItemSchema = z.object({
  id: noteIdSchema,
  text: z.string().min(1),
});
export type NoteStringItem = z.infer<typeof noteStringItemSchema>;

/** {@link typeInsightsContentSchema}, with each arm's entries identified. */
export const typeInsightsSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sales"),
    objections: z.array(noteStringItemSchema),
    buyingSignals: z.array(noteStringItemSchema),
  }),
  z.object({
    kind: z.literal("interview"),
    questionsAsked: z.array(noteStringItemSchema),
    answersToRevisit: z.array(noteStringItemSchema),
  }),
  z.object({ kind: z.literal("casual") }),
]);
export type TypeInsights = z.infer<typeof typeInsightsSchema>;

/**
 * Where a notes object came from. `generated`/`fallback` are the post-call
 * pipeline's two outcomes (the UI keys a retry affordance off `fallback`).
 */
export const notesSourceSchema = z.enum(["generated", "fallback"]);
export type NotesSource = z.infer<typeof notesSourceSchema>;

/**
 * The full notes object stored on a meeting (v2). `.strict()` rejects unknown
 * top-level keys so a model that pads the object with extra fields fails the parse
 * (RULES §1 — LLM output is hostile input; unmodelled keys are a smell, not
 * silently kept).
 */
export const meetingNotesSchema = z
  .object({
    version: z.literal(2),
    conversationType: conversationTypeSchema,
    title: z.string().min(1),
    tldr: z.string().min(1),
    overview: z.string().min(1),
    decisions: z.array(noteDecisionSchema),
    actionItems: z.array(noteActionItemSchema),
    openQuestions: z.array(noteStringItemSchema),
    risks: z.array(noteStringItemSchema),
    typeInsights: typeInsightsSchema,
    source: notesSourceSchema,
  })
  .strict();
export type MeetingNotes = z.infer<typeof meetingNotesSchema>;

// ---------------------------------------------------------------------------
// content → identified
// ---------------------------------------------------------------------------

/** `<prefix><1-based index>` — the deterministic mint used at every assembly point. */
function mintIds<T, R>(
  items: readonly T[],
  list: NoteListKey,
  build: (item: T, id: string) => R,
): R[] {
  return items.map((item, i) =>
    build(item, `${NOTE_ID_PREFIX[list]}${String(i + 1)}`),
  );
}

/** Promote a plain-string list to identified items under its own prefix. */
function identifyStrings(
  items: readonly string[],
  list: NoteListKey,
): NoteStringItem[] {
  return mintIds(items, list, (text, id) => ({ id, text }));
}

/** Identify whichever insights arm is present, leaving `casual` alone (no lists). */
function identifyInsights(insights: TypeInsightsContent): TypeInsights {
  switch (insights.kind) {
    case "sales":
      return {
        kind: "sales",
        objections: identifyStrings(insights.objections, "objections"),
        buyingSignals: identifyStrings(insights.buyingSignals, "buyingSignals"),
      };
    case "interview":
      return {
        kind: "interview",
        questionsAsked: identifyStrings(
          insights.questionsAsked,
          "questionsAsked",
        ),
        answersToRevisit: identifyStrings(
          insights.answersToRevisit,
          "answersToRevisit",
        ),
      };
    case "casual":
      return { kind: "casual" };
  }
}

/**
 * The pure content → v2 bridge: mint an id for every itemized entry and stamp
 * `version`/`source`. Deterministic (ids are positional), so the same content
 * always yields the same object — which is what makes it safe to call on the read
 * path for stored v1 rows as well as at post-call assembly.
 *
 * Ids are minted HERE, in code, and never requested from the model: the post-call
 * prompt contract is unchanged by v2, and a hostile/sloppy model can never choose
 * an item's identity.
 */
export function identifyNotes(
  content: NotesContent,
  source: NotesSource,
): MeetingNotes {
  return {
    version: 2,
    conversationType: content.conversationType,
    title: content.title,
    tldr: content.tldr,
    overview: content.overview,
    decisions: mintIds(content.decisions, "decisions", (d, id) => ({
      ...d,
      id,
    })),
    actionItems: mintIds(content.actionItems, "actionItems", (a, id) => ({
      ...a,
      id,
    })),
    openQuestions: identifyStrings(content.openQuestions, "openQuestions"),
    risks: identifyStrings(content.risks, "risks"),
    typeInsights: identifyInsights(content.typeInsights),
    source,
  };
}

// ---------------------------------------------------------------------------
// The v1 read boundary
// ---------------------------------------------------------------------------

/**
 * The v1 notes shape, FROZEN. Rows written before 2026-07-25 hold exactly this.
 * Never extend it — it exists only so {@link storedNotesSchema} can recognise an
 * old row and upcast it. New fields go on {@link meetingNotesSchema}.
 */
export const meetingNotesV1Schema = z
  .object({
    version: z.literal(1),
    conversationType: conversationTypeSchema,
    title: z.string().min(1),
    tldr: z.string().min(1),
    overview: z.string().min(1),
    decisions: z.array(noteDecisionContentSchema),
    actionItems: z.array(noteActionItemContentSchema),
    openQuestions: z.array(z.string()),
    risks: z.array(z.string()),
    typeInsights: typeInsightsContentSchema,
    source: z.enum(["generated", "fallback"]),
  })
  .strict();
export type MeetingNotesV1 = z.infer<typeof meetingNotesV1Schema>;

/** Upcast a stored v1 object to v2, minting positional ids. Pure + deterministic. */
export function upcastNotesV1(v1: MeetingNotesV1): MeetingNotes {
  return identifyNotes(
    {
      conversationType: v1.conversationType,
      title: v1.title,
      tldr: v1.tldr,
      overview: v1.overview,
      decisions: v1.decisions,
      actionItems: v1.actionItems,
      openQuestions: v1.openQuestions,
      risks: v1.risks,
      typeInsights: v1.typeInsights,
    },
    v1.source,
  );
}

/**
 * The READ boundary for `meetings.notes` — accepts either stored version and always
 * yields v2, so every consumer downstream sees exactly one shape. Used by
 * `db/notes.ts` (the REST read model) and `db/schema.ts` (the meetings row).
 *
 * This union is what keeps pre-v2 meetings readable. Writers never use it: they
 * emit v2 via {@link identifyNotes}. Rows upgrade naturally on the next regenerate;
 * no backfill migration is required (the column type does not change — only the
 * jsonb payload's app-level version does).
 */
export const storedNotesSchema = z
  .union([meetingNotesV1Schema, meetingNotesSchema])
  .transform((notes): MeetingNotes =>
    notes.version === 1 ? upcastNotesV1(notes) : notes,
  );

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

/** The read-model status the product observes without joining the jobs queue. */
export const notesStatusSchema = z.enum([
  "none",
  "queued",
  "processing",
  "completed",
  "failed",
]);
export type NotesStatus = z.infer<typeof notesStatusSchema>;

/**
 * The follow-up draft AS STORED on `meetings.follow_up` and returned on GET — the
 * draft plus the moment it was generated (`generated_at`, ISO). The POST /follow-up
 * response itself is the bare {@link followUpDraftSchema} (no timestamp); the stored
 * shape adds it so a reader can show when the draft was written.
 */
export const followUpStoredSchema = followUpDraftSchema.extend({
  generated_at: z.string(),
});
export type FollowUpStored = z.infer<typeof followUpStoredSchema>;

/**
 * `GET /meetings/:id/notes` response — the meeting's read model. `notes`/`follow_up`
 * are null until generation completes; `notes_status` drives the mobile UI (a
 * `failed`/`fallback` state keys a retry affordance). A missing/foreign/soft-deleted
 * meeting returns a uniform 404 instead of this shape (no existence leak).
 */
export const notesReadResponseSchema = z.object({
  notes_status: notesStatusSchema,
  notes: meetingNotesSchema.nullable(),
  follow_up: followUpStoredSchema.nullable(),
  notes_generated_at: z.string().nullable(),
  /**
   * Action-item ids the user has checked off, filtered to those whose stored text
   * still matches the item now at that id (Phase 8.5, `docs/DESIGN/notes-ui.md`
   * §6.3). Empty when nothing is checked.
   *
   * A SEPARATE array rather than a `completed` flag on each action item, on
   * purpose: `noteActionItemSchema` is the STORED notes shape, written into
   * `meetings.notes` verbatim. Threading a read-only, user-authored field
   * through it would put presentation state into a server-authored document.
   * The client renders `completed_item_ids.includes(item.id)`.
   *
   * Ordered by the notes' own action-item order, so the array is stable and
   * diffable rather than dependent on the DB's row order.
   *
   * DEFAULTED rather than required, deliberately. This is a mobile wire contract:
   * an installed app cannot be force-updated, so a new client will at some point
   * parse a response from an older server (a staged rollout, a rollback), and a
   * hard parse failure there would take out the entire notes screen over a
   * checkbox array. Absent reads as "nothing checked", which is both the truthful
   * answer for a server that has no completion state and the safe direction.
   *
   * The default is a FACTORY: `.default([])` hands the SAME array instance to every
   * parse that omits the field, so one in-place mutation downstream would be seen by
   * every other caller. `() => []` mints a fresh one each time.
   */
  completed_item_ids: z.array(noteIdSchema).default(() => []),
});
export type NotesReadResponse = z.infer<typeof notesReadResponseSchema>;

/** `POST /meetings/:id/notes/regenerate` 202 body — the job was (re)queued. */
export const regenerateResponseSchema = z.object({
  status: z.literal("queued"),
});
export type RegenerateResponse = z.infer<typeof regenerateResponseSchema>;

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
  return identifyNotes(
    {
      conversationType: "casual",
      title: safeTitle,
      tldr: FALLBACK_TLDR,
      overview: FALLBACK_TLDR,
      decisions: [],
      actionItems: [],
      openQuestions: [],
      risks: [],
      typeInsights: { kind: "casual" },
    },
    "fallback",
  );
}
