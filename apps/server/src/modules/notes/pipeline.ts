import {
  buildFallbackNotes,
  conversationTypeSchema,
  meetingNotesSchema,
  type ConversationType,
  type MeetingNotes,
} from "@nova/shared";
import { z } from "zod";

import type { JobUsage } from "../../db/jobs.js";
import type { LlmRouter } from "../llm/index.js";

import { notesConfigSchema, type NotesConfig } from "./config.js";
import { bufferStream, runLadder } from "./ladder.js";
import type {
  NotesLogger,
  NotesMeetingMeta,
  NotesPipeline,
  TranscriptTurn,
} from "./ports.js";
import { buildClassifyMessages, buildGenerateMessages } from "./prompts/types.js";
import { buildNotesRepairMessages } from "./prompts/repair.js";
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

/** Construction dependencies (the locked Task 3 signature). */
export interface NotesPipelineDeps {
  readonly router: LlmRouter;
  readonly config?: Partial<NotesConfig>;
  readonly logger: NotesLogger;
  /** Injected clock — deadline anchoring falls back to this when `startedAt` is null. */
  readonly now?: () => Date;
}

/** Build the single-pass notes pipeline over explicit deps (pure of env/DB). */
export function createNotesPipeline(deps: NotesPipelineDeps): NotesPipeline {
  const { router, logger } = deps;
  const config = notesConfigSchema.parse(deps.config ?? {});
  const now = deps.now ?? ((): Date => new Date());

  async function generate(
    meta: NotesMeetingMeta,
    turns: TranscriptTurn[],
  ): Promise<{ notes: MeetingNotes; usage: JobUsage[] }> {
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

    const type = await classify(turns, usage);
    const { callDate, weekday } = resolveCallDate(meta.startedAt, now);
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

    const generated: MeetingNotes =
      ladder.result.status === "ok"
        ? { ...ladder.result.value, version: 1, source: "generated" }
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

    return { notes, usage };
  }

  /**
   * Classify the call from its head (`classifyHeadTokens` × ~4 chars/token — the
   * documented char/token heuristic; no tokenizer dependency). Enum zod-parse; ANY
   * failure (unparseable output OR a transport throw) degrades to 'casual', the
   * neutral shape (adr §8). Usage is captured on success.
   */
  async function classify(
    turns: TranscriptTurn[],
    usage: JobUsage[],
  ): Promise<ConversationType> {
    const headChars = config.classifyHeadTokens * 4;
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
  return meetingNotesSchema
    .omit({ version: true, source: true })
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

/** Render diarized turns as `[mm:ss] Speaker: text` lines for the prompt. */
function formatTranscript(turns: TranscriptTurn[]): string {
  return turns
    .map((turn) => {
      const who = turn.speaker ?? "Unknown";
      const stamp = turn.tsMs !== null ? `[${formatTimestamp(turn.tsMs)}] ` : "";
      return `${stamp}${who}: ${turn.text}`;
    })
    .join("\n");
}

/** `mm:ss` from a millisecond offset. */
function formatTimestamp(tsMs: number): string {
  const totalSeconds = Math.floor(tsMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
