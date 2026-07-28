import {
  conversationTypeSchema,
  type ConversationType,
  type MeetingNotes,
} from "@nova/shared";

import type { LlmRouter } from "../llm/index.js";

import { formatTranscript } from "./format.js";
import { bufferStream, runLadder } from "./ladder.js";
import {
  applyFold,
  foldResultSchema,
  type FoldOutcome,
  type FoldState,
  type LiveFoldConfig,
} from "./live-fold.js";
import type { NotesLogger, TranscriptTurn } from "./ports.js";
import {
  buildFoldMessages,
  buildFoldRepairMessages,
  renderNotesDigest,
} from "./prompts/live-fold.js";
import { CHARS_PER_TOKEN } from "./tokens.js";

/**
 * One fold, end to end: render the digest + delta, walk the structured-output
 * ladder, and reduce the resulting ops through {@link applyFold} (Phase 8,
 * docs/DESIGN/live-notes.md §3).
 *
 * This lives in `modules/notes` rather than in the conductor because it is all
 * NOTES domain — the prompt, the ops schema, the reducer, the quote check. The
 * conductor in `modules/live` owns only the LOOP: when to fold, what has accrued
 * since the last one, and what to do with the result. That split is what keeps the
 * cross-module surface (RULES §2) down to this one interface instead of a dozen
 * prompt and ladder internals.
 */

/** Everything one fold attempt needs from the caller. */
export interface FoldRequest {
  readonly prior: MeetingNotes;
  /** Transcript accrued since the last fold that landed. */
  readonly delta: readonly TranscriptTurn[];
  readonly state: FoldState;
  readonly narrativeOpen: boolean;
  /** No narrative has ever landed — the model must produce one, not offer to. */
  readonly narrativeRequired?: boolean;
  /** Transcript so far, for the quote check — the whole call, not just the delta. */
  readonly transcriptSoFar: string;
  readonly canLatchType: boolean;
  /** `YYYY-MM-DD`, for relative-deadline resolution. */
  readonly callDate: string;
  /**
   * A type the classifier determined but the notes have not adopted yet. It
   * drives the PROMPT (which lists exist, which guidance is shown) and is merged
   * into the model's result so the reducer's latch applies it — otherwise the
   * classifier's answer would depend on the fold model volunteering the same one.
   */
  readonly classifiedType?: ConversationType;
  readonly signal?: AbortSignal;
}

export interface LiveFoldRunner {
  /**
   * Run one fold. Returns `null` when the model's response never became
   * schema-valid — the caller must then RETAIN its delta, because a fold that
   * consumed it and produced nothing has lost that content for good.
   *
   * Throws only on transport failure (the router's own `LlmError` /
   * `AllProvidersFailedError`), which the caller treats the same way: retain.
   */
  fold(request: FoldRequest): Promise<FoldOutcome | null>;

  /**
   * One small call to label the call type. Best-effort in exactly the way the
   * post-call pipeline's classifier is: any failure degrades to `casual`, the
   * neutral shape, rather than sinking the fold.
   */
  classify(
    turns: readonly TranscriptTurn[],
    signal?: AbortSignal,
  ): Promise<ConversationType>;
}

export interface LiveFoldRunnerDeps {
  /** Already meter-wrapped by the caller — every call here is attributed. */
  readonly router: LlmRouter;
  readonly config: LiveFoldConfig;
  readonly logger: NotesLogger;
  /** Transcript head, in tokens, handed to the classifier. */
  readonly classifyHeadTokens?: number;
}

const DEFAULT_CLASSIFY_HEAD_TOKENS = 500;

export function createLiveFoldRunner(deps: LiveFoldRunnerDeps): LiveFoldRunner {
  const { router, config, logger } = deps;
  const classifyHeadTokens =
    deps.classifyHeadTokens ?? DEFAULT_CLASSIFY_HEAD_TOKENS;

  return {
    async fold(request: FoldRequest): Promise<FoldOutcome | null> {
      const type = request.classifiedType ?? request.prior.conversationType;
      const messages = buildFoldMessages({
        type,
        digest: renderNotesDigest(request.prior, type, config.maxItemsPerList),
        delta: formatTranscript([...request.delta]),
        callDate: request.callDate,
        narrativeOpen: request.narrativeOpen,
        ...(request.narrativeRequired !== undefined
          ? { narrativeRequired: request.narrativeRequired }
          : {}),
      });

      const ladder = await runLadder({
        schema: foldResultSchema,
        messages,
        router,
        repair: (invalidText, issues) =>
          buildFoldRepairMessages(
            type,
            request.narrativeOpen,
            invalidText,
            issues,
          ),
        ...(request.signal ? { signal: request.signal } : {}),
      });

      if (ladder.result.status !== "ok") {
        // RULES §6: shape only. The raw text is model output over a live
        // transcript — it is never logged, at any level.
        logger.error(
          {
            salvage_applied: ladder.telemetry.salvageApplied,
            repair_used: ladder.telemetry.repairUsed,
          },
          "notes.live_fold.schema_reject",
        );
        return null;
      }

      // The classifier's answer rides in as if the model had proposed it, so the
      // reducer's one-way `casual → typed` latch is the single place a type
      // transition can happen (rule 9) — there is no second path around it.
      const proposed =
        request.classifiedType === undefined
          ? ladder.result.value
          : {
              ...ladder.result.value,
              conversationType: request.classifiedType,
            };

      const outcome = applyFold(request.prior, proposed, {
        config,
        state: request.state,
        narrativeOpen: request.narrativeOpen,
        transcriptSoFar: request.transcriptSoFar,
        canLatchType: request.canLatchType,
      });

      if (outcome.dropped.length > 0) {
        // Ids, list names and reasons only — never item text (RULES §6).
        logger.info(
          {
            dropped: outcome.dropped.length,
            reasons: outcome.dropped.map((drop) => drop.reason),
          },
          "notes.live_fold.ops_dropped",
        );
      }

      return outcome;
    },

    async classify(
      turns: readonly TranscriptTurn[],
      signal?: AbortSignal,
    ): Promise<ConversationType> {
      const head = formatTranscript([...turns]).slice(
        0,
        classifyHeadTokens * CHARS_PER_TOKEN,
      );
      try {
        const { text } = await bufferStream(
          router,
          [
            {
              role: "system",
              content:
                "You label the type of a phone call from its opening. Answer with exactly ONE lowercase word: sales, interview, or casual.",
            },
            {
              role: "user",
              content: `Opening of the call:\n\n${head}\n\nOne word — sales, interview, or casual:`,
            },
          ],
          signal,
        );
        const word =
          text
            .trim()
            .toLowerCase()
            .replace(/[^a-z]/g, " ")
            .split(/\s+/)
            .find(Boolean) ?? "";
        const parsed = conversationTypeSchema.safeParse(word);
        return parsed.success ? parsed.data : "casual";
      } catch {
        // Best-effort, exactly like the post-call classifier: an unusable answer
        // OR a provider failure both fall to the neutral shape.
        return "casual";
      }
    },
  };
}
