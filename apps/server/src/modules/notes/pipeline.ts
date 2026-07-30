import { z } from "zod";
import {
  buildFallbackNotes,
  conversationTypeSchema,
  identifyNotes,
  notesContentSchema,
  type ConversationType,
  type MeetingNotes,
} from "@nova/shared";

import type { JobUsage } from "../../db/jobs.js";
import { withMeter, type LlmRouter, type Meter } from "../llm/index.js";

import { notesConfigSchema, type NotesConfig } from "./config.js";
import { formatTranscript } from "./format.js";
import { bufferStream, runLadder } from "./ladder.js";
import { runMapReduce } from "./map-reduce.js";
import type {
  NotesLogger,
  NotesMeetingMeta,
  NotesPipeline,
  TranscriptTurn,
} from "./ports.js";
import { buildNotesRepairMessages } from "./prompts/repair.js";
import {
  buildClassifyMessages,
  buildGenerateMessages,
} from "./prompts/types.js";
import { CHARS_PER_TOKEN, estimateTokens } from "./tokens.js";
import { joinTranscriptText, verifyNotes } from "./verify-quotes.js";

/**
 * The single-pass generation core (adr-0006 §5–§8; Task 4 adds the map-reduce arm
 * above `maxSinglePassTokens`). The flow:
 *
 *   classify (small call, any failure → 'casual')
 *     → generate (transcript at the TOP, pinned per-type schema at the BOTTOM,
 *        call date + weekday injected for deadline resolution)
 *     → structured-output ladder (salvage → zod → one repair → fallback)
 *     → verify quotes + invented-date guard
 *     → { notes, usage }
 *
 * NEVER throws for content reasons (the ladder ends in `buildFallbackNotes`); a
 * transport/all-providers failure DOES throw so the worker retries (adr §3). Usage
 * accumulates one entry per model call (classify + generate + repair when spent).
 * Provider ids are not populated: the locked {@link LlmRouter} port reports token
 * counts on the `done` event but not the committed provider (Task 4/5 handoff).
 */

/** Construction dependencies (the locked Task 3 signature + the Phase 6 meter seam). */
export interface NotesPipelineDeps {
  readonly router: LlmRouter;
  readonly config?: Partial<NotesConfig>;
  readonly logger: NotesLogger;
  /** Injected clock — deadline anchoring falls back to this when `startedAt` is null. */
  readonly now?: () => Date;
  /**
   * Per-job metering factory (Phase 6, adr-0007 §2 — `metering.meterFor`). The
   * pipeline is constructed ONCE but runs per job, so attribution is a factory,
   * not a single meter: each `generate` builds ONE meter for (meta.userId,
   * meta.id) and threads it into EVERY router call of that job (classify,
   * generate, map, reduce, repair). Optional — absent, calls carry no meter.
   */
  readonly meterFor?: (userId: string, meetingId?: string) => Meter;
}

/** Build the single-pass notes pipeline over explicit deps (pure of env/DB). */
export function createNotesPipeline(deps: NotesPipelineDeps): NotesPipeline {
  const { logger } = deps;
  const config = notesConfigSchema.parse(deps.config ?? {});
  const now = deps.now ?? ((): Date => new Date());

  async function generate(
    meta: NotesMeetingMeta,
    turns: TranscriptTurn[],
  ): Promise<{ notes: MeetingNotes; usage: JobUsage[]; rawText?: string }> {
    // The job-scoped router: when metering is wired, every call below reports
    // through the meter stamped with THIS job's user + meeting.
    const router = deps.meterFor
      ? withMeter(deps.router, deps.meterFor(meta.userId, meta.id))
      : deps.router;
    const usage: JobUsage[] = [];
    const transcriptText = joinTranscriptText(turns);

    // Empty transcript is not an error — it deterministically yields fallback notes
    // (adr §3) without spending a paid call.
    if (transcriptText.trim() === "") {
      logger.info(
        { meeting_id: meta.id, reason: "empty_transcript" },
        "notes.pipeline.fallback",
      );
      return { notes: buildFallbackNotes(meta.title), usage };
    }

    const type = await classify(router, turns, usage);
    const { callDate, weekday } = resolveCallDate(meta.startedAt, now);

    // Threshold gate (adr §5): a transcript over `maxSinglePassTokens` degrades
    // effective-context recall (itemized extraction dies first), so it takes the
    // map-reduce arm instead of one over-stuffed single-pass call.
    if (estimateTokens(formatTranscript(turns)) > config.maxSinglePassTokens) {
      const mr = await runMapReduce({
        deps: { router, config, logger },
        meta,
        turns,
        type,
        callDate,
        weekday,
        transcriptText,
      });
      usage.push(...mr.usage);
      logger.info(
        {
          meeting_id: meta.id,
          conversation_type: mr.notes.conversationType,
          path: "map_reduce",
          model_calls: usage.length,
        },
        "notes.pipeline.generated",
      );
      return mr.rawText !== undefined
        ? { notes: mr.notes, usage, rawText: mr.rawText }
        : { notes: mr.notes, usage };
    }

    const messages = buildGenerateMessages({
      type,
      transcript: formatTranscript(turns),
      callDate,
      weekday,
    });

    const ladder = await runLadder({
      schema: requestSchemaFor(type),
      messages,
      router,
      repair: (invalidText, issues) =>
        buildNotesRepairMessages(type, invalidText, issues),
    });
    usage.push(...ladder.usage);

    // The ladder validates the model's id-LESS content; `identifyNotes` stamps
    // version/source and mints the item ids in code (v2 — the model is never asked
    // for an identity it could hallucinate). docs/DESIGN/live-notes.md §2.
    const generated: MeetingNotes =
      ladder.result.status === "ok"
        ? identifyNotes(ladder.result.value, "generated")
        : buildFallbackNotes(meta.title);

    const notes = verifyNotes(generated, transcriptText);

    logger.info(
      {
        meeting_id: meta.id,
        conversation_type: notes.conversationType,
        salvage_applied: ladder.telemetry.salvageApplied,
        repair_used: ladder.telemetry.repairUsed,
        fell_back: ladder.telemetry.fellBack,
        model_calls: usage.length,
      },
      "notes.pipeline.generated",
    );

    // Surface the last raw model text when the ladder fell back, so a terminal
    // handler path can hand it to `jobs.raw_output` (adr §7 — malformed JSON off
    // the typed notes column). Omitted on the clean path (nothing to keep).
    return ladder.telemetry.fellBack
      ? { notes, usage, rawText: ladder.rawText }
      : { notes, usage };
  }

  /**
   * Classify the call from its head (`classifyHeadTokens` × ~4 chars/token — the
   * documented char/token heuristic; no tokenizer dependency). Enum zod-parse; ANY
   * failure (unparseable output OR a transport throw) degrades to 'casual', the
   * neutral shape (adr §8). Usage is captured on success.
   */
  async function classify(
    router: LlmRouter,
    turns: TranscriptTurn[],
    usage: JobUsage[],
  ): Promise<ConversationType> {
    const headChars = config.classifyHeadTokens * CHARS_PER_TOKEN;
    const head = formatTranscript(turns).slice(0, headChars);
    try {
      const { text, usage: callUsage } = await bufferStream(
        router,
        buildClassifyMessages(head),
      );
      usage.push(callUsage);
      return parseConversationType(text);
    } catch {
      // Classification is best-effort: a bad/absent word OR a provider failure both
      // fall to the neutral 'casual' shape rather than sinking the whole job.
      return "casual";
    }
  }

  return { generate };
}

/**
 * Build the per-type request schema: the shared notes shape MINUS the pipeline-
 * stamped `version`/`source`, with `conversationType` pinned to the classified
 * literal and a refinement pinning `typeInsights.kind` to the matching arm. A model
 * that returns a mismatched type/arm fails the parse → the ladder's one repair round
 * (adr §8 — the arm is pinned by the schema, not just the prose).
 */
function requestSchemaFor(type: ConversationType) {
  return notesContentSchema
    .extend({ conversationType: z.literal(type) })
    .refine((notes) => notes.typeInsights.kind === type, {
      message: `typeInsights.kind must be "${type}"`,
      path: ["typeInsights", "kind"],
    });
}

/** Enum zod-parse with a keyword-scan safety net; anything unrecognised → 'casual'. */
function parseConversationType(raw: string): ConversationType {
  const firstWord =
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, " ")
      .split(/\s+/)
      .find(Boolean) ?? "";
  const parsed = conversationTypeSchema.safeParse(firstWord);
  if (parsed.success) {
    return parsed.data;
  }
  // The model wrapped the word in a sentence — take whichever enum value appears first.
  const lower = raw.toLowerCase();
  const hit = conversationTypeSchema.options
    .map((value) => ({ value, index: lower.indexOf(value) }))
    .filter((candidate) => candidate.index >= 0)
    .sort((a, b) => a.index - b.index)[0];
  return hit?.value ?? "casual";
}

/**
 * Resolve the call's anchor date + weekday for relative-deadline resolution, in
 * UTC (deterministic regardless of server timezone). Falls back to the injected
 * clock when `startedAt` is null or unparseable.
 */
function resolveCallDate(
  startedAt: string | null,
  now: () => Date,
): { callDate: string; weekday: string } {
  const parsed = startedAt !== null ? new Date(startedAt) : now();
  const base = Number.isNaN(parsed.getTime()) ? now() : parsed;
  const callDate = base.toISOString().slice(0, 10);
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "UTC",
  }).format(base);
  return { callDate, weekday };
}
