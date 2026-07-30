import { z } from "zod";

/**
 * Notes-conductor tunables (Phase 8, docs/DESIGN/live-notes.md §4). Mirrors
 * `conductor-config.ts`: zod, fully defaulted, so tests drive tiny values under
 * fake timers and the defaults stay the one place production behaviour is set.
 *
 * The cost lever is `foldIntervalMs`: on an hour-long call it decides whether the
 * feature costs ~$0.10 or ~$0.25, near-linearly. 25s is a starting estimate, not a
 * measured optimum (§12.4) — it is one value to tune against a real call.
 */
export const notesConductorConfigSchema = z.object({
  /**
   * Debounce between fold attempts. THIS is the real rate limiter — the gate is a
   * small-talk suppressor, not the cost control (§5).
   */
  foldIntervalMs: z.number().int().positive().default(25_000),
  /** Below this many accrued turns, a fold is not worth a call. */
  minUtterancesPerFold: z.number().int().positive().default(2),
  /**
   * FORCE-FIRE ceiling: once the delta exceeds this many estimated tokens, fold
   * even if the gate says quiet. A gate tuned toward quiet must never starve a
   * diffuse-but-substantive stretch — this is the mitigation for the gate's one
   * genuinely dangerous failure mode (§5).
   */
  maxDeltaTokens: z.number().int().positive().default(900),
  /**
   * Hard per-session fold budget. Recording spend is not LIMITING spend (§0.9):
   * the $50/day kill-switch only refuses NEW sessions, so without this a single
   * pathological call has no ceiling of its own.
   */
  maxFoldsPerSession: z.number().int().positive().default(200),
  /** Turns of transcript before a conversation-type transition may be honoured. */
  classifyMinTurns: z.number().int().positive().default(12),
  /**
   * Narrative window cadence — every Nth fold (~2 min at the default interval).
   * Rewriting tldr/overview ~144×/hour reads as churn no matter how it animates.
   */
  narrativeEveryNFolds: z.number().int().positive().default(4),
  /** …or sooner, once this many items have been added/removed since the last one. */
  narrativeItemDelta: z.number().int().positive().default(5),
  /** Floor on how many existing items ONE fold may touch, per list. */
  maxChurnPerFold: z.number().int().positive().default(3),
  /** …or this fraction of the list, whichever is larger. */
  churnFraction: z.number().min(0).max(1).default(0.25),
  /** Hard per-list item cap. Bounds a 3-hour call. */
  maxItemsPerList: z.number().int().positive().default(40),
  /** Rolling transcript turns kept for the quote check. */
  transcriptWindowTurns: z.number().int().positive().default(400),
  /**
   * Cost backstop on the retained delta. §4 keeps the delta on EVERY unsuccessful
   * fold — losing it would lose that content for good, since the fold never
   * re-reads the transcript. But a model that keeps answering "nothing new" would
   * then grow the delta, and every subsequent fold pays for it in input tokens.
   * Past this many turns the OLDEST are dropped: the newest content, which is what
   * a fold is most likely to still act on, is what survives.
   */
  maxDeltaTurns: z.number().int().positive().default(300),
});

export type NotesConductorConfig = z.infer<typeof notesConductorConfigSchema>;

/** Process-wide default notes-conductor config. */
export const notesConductorConfig: NotesConductorConfig =
  notesConductorConfigSchema.parse({});
