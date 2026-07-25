import {
  buildFallbackNotes,
  FALLBACK_TLDR,
  identifyNotes,
  typeInsightsContentSchema,
  type ConversationType,
  type MeetingNotes,
  type NoteActionItemContent,
  type NoteDecisionContent,
  type NotesContent,
  type TypeInsightsContent,
} from "@nova/shared";
import { z } from "zod";

import type { JobUsage } from "../../db/jobs.js";
import type { LlmRouter } from "../llm/index.js";

import { chunkTurns } from "./chunking.js";
import type { NotesConfig } from "./config.js";
import { formatTranscript } from "./format.js";
import { runLadder } from "./ladder.js";
import type { NotesLogger, NotesMeetingMeta, TranscriptTurn } from "./ports.js";
import { buildMapMessages, buildMapRepairMessages } from "./prompts/map.js";
import {
  buildReduceMessages,
  buildReduceRepairMessages,
  type ReduceFacts,
} from "./prompts/reduce.js";
import { normalizeForMatch, verifyNotes } from "./verify-quotes.js";

/**
 * The MAP-REDUCE generation arm (adr-0006 §5; DESIGN §generation-decisions). Taken
 * ONLY above `maxSinglePassTokens` (the pipeline gates; tests force it by lowering
 * the gate). The shape:
 *
 *   1. CHUNK the transcript at turn boundaries with ~15% overlap (`chunking.ts`).
 *   2. MAP each chunk → structured facts + a 3-sentence mini-summary, through the
 *      SAME structured-output ladder as single-pass. Chunks run SEQUENTIALLY (the
 *      router is one shared seam; parallel fan-out is a logged future opener). A
 *      chunk that exhausts the ladder falls back to EMPTY facts — it never aborts
 *      the meeting.
 *   3. REDUCE — merge facts across chunks IN CODE (dedup decisions + action items
 *      by normalized text), then ONE reduce LLM call writes the narrative + type
 *      insights from the ORDERED mini-summaries (equal weight to early + late).
 *      The merged decisions/action items are assembled around the reduce call —
 *      never re-derived from prose, which is where early-call facts die.
 *   4. VERIFY every quote against the FULL transcript, then return.
 *
 * Usage accumulates across every map + reduce call. `rawText` is surfaced only when
 * the reduce ladder fell back (the terminal-handler seam).
 */

// ---------------------------------------------------------------------------
// Map extraction schema. Every field is required (input == output — the generic
// ladder infers a single type), with the ladder's repair round-trip + empty-facts
// fallback covering an omission; the map prompt instructs the model to emit empty
// arrays rather than drop keys. INTERNAL only (never persisted). A non-ISO
// `deadline` is accepted here and sanitized to null during assembly, so one bad
// date can't reject a whole chunk's facts.
// ---------------------------------------------------------------------------

const factDecisionSchema = z.object({
  text: z.string().min(1),
  quote: z.string().nullable(),
});

const factActionItemSchema = z.object({
  text: z.string().min(1),
  owner: z.string().nullable(),
  deadline: z.string().nullable(),
  deadlineRaw: z.string().nullable(),
  quote: z.string().nullable(),
});

const insightsSchema = z.object({
  objections: z.array(z.string()),
  buyingSignals: z.array(z.string()),
  questionsAsked: z.array(z.string()),
  answersToRevisit: z.array(z.string()),
});

const chunkFactsSchema = z.object({
  miniSummary: z.string(),
  decisions: z.array(factDecisionSchema),
  actionItems: z.array(factActionItemSchema),
  openQuestions: z.array(z.string()),
  risks: z.array(z.string()),
  insights: insightsSchema,
});

type ChunkFacts = z.infer<typeof chunkFactsSchema>;

const EMPTY_CHUNK_FACTS: ChunkFacts = {
  miniSummary: "",
  decisions: [],
  actionItems: [],
  openQuestions: [],
  risks: [],
  insights: {
    objections: [],
    buyingSignals: [],
    questionsAsked: [],
    answersToRevisit: [],
  },
};

/** ISO calendar date guard — a `deadline` that fails this is nulled in assembly. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The reduce request schema: narrative + type insights, insights arm pinned to type. */
function reduceRequestSchema(type: ConversationType) {
  return z
    .object({
      title: z.string().min(1),
      tldr: z.string().min(1),
      overview: z.string().min(1),
      openQuestions: z.array(z.string()),
      risks: z.array(z.string()),
      typeInsights: typeInsightsContentSchema,
    })
    .strict()
    .refine((notes) => notes.typeInsights.kind === type, {
      message: `typeInsights.kind must be "${type}"`,
      path: ["typeInsights", "kind"],
    });
}

// ---------------------------------------------------------------------------
// Construction inputs.
// ---------------------------------------------------------------------------

export interface MapReduceDeps {
  readonly router: LlmRouter;
  readonly config: NotesConfig;
  readonly logger: NotesLogger;
}

export interface MapReduceParams {
  readonly deps: MapReduceDeps;
  readonly meta: NotesMeetingMeta;
  readonly turns: TranscriptTurn[];
  readonly type: ConversationType;
  readonly callDate: string;
  readonly weekday: string;
  /** The full joined transcript, for post-assembly quote verification. */
  readonly transcriptText: string;
}

export interface MapReduceResult {
  readonly notes: MeetingNotes;
  readonly usage: JobUsage[];
  readonly rawText?: string;
}

// ---------------------------------------------------------------------------
// Merge helpers (the "reduce merges facts in code" contract).
// ---------------------------------------------------------------------------

/** Dedup strings by normalized text (lowercase + whitespace/punct collapse), first wins. */
function dedupStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = normalizeForMatch(value);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** Merge + dedup decisions by normalized text; first occurrence (earliest chunk) wins. */
function dedupDecisions(
  items: ChunkFacts["decisions"],
): NoteDecisionContent[] {
  const seen = new Set<string>();
  const out: NoteDecisionContent[] = [];
  for (const item of items) {
    const key = normalizeForMatch(item.text);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push({ text: item.text, quote: item.quote });
  }
  return out;
}

/** Merge + dedup action items by normalized text; sanitize non-ISO deadlines to null. */
function dedupActionItems(
  items: ChunkFacts["actionItems"],
): NoteActionItemContent[] {
  const seen = new Set<string>();
  const out: NoteActionItemContent[] = [];
  for (const item of items) {
    const key = normalizeForMatch(item.text);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    const deadline =
      item.deadline !== null && ISO_DATE_RE.test(item.deadline)
        ? item.deadline
        : null;
    out.push({
      text: item.text,
      owner: item.owner,
      deadline,
      deadlineRaw: item.deadlineRaw,
      quote: item.quote,
    });
  }
  return out;
}

/** Build the pinned `typeInsights` arm from merged insight candidates (reduce-fallback path). */
function insightsFor(
  type: ConversationType,
  merged: {
    objections: string[];
    buyingSignals: string[];
    questionsAsked: string[];
    answersToRevisit: string[];
  },
): TypeInsightsContent {
  switch (type) {
    case "sales":
      return {
        kind: "sales",
        objections: merged.objections,
        buyingSignals: merged.buyingSignals,
      };
    case "interview":
      return {
        kind: "interview",
        questionsAsked: merged.questionsAsked,
        answersToRevisit: merged.answersToRevisit,
      };
    case "casual":
      return { kind: "casual" };
  }
}

/** Deterministic narrative when the reduce call fell back but facts exist. */
function deterministicNarrative(
  meta: NotesMeetingMeta,
  summaries: string[],
): { title: string; tldr: string; overview: string } {
  const title = meta.title.trim() === "" ? "Untitled call" : meta.title;
  const joined = summaries.join(" ").trim();
  return {
    title,
    tldr: summaries[0]?.trim() || FALLBACK_TLDR,
    overview: joined !== "" ? joined.slice(0, 1200) : FALLBACK_TLDR,
  };
}

// ---------------------------------------------------------------------------
// The arm.
// ---------------------------------------------------------------------------

/** Run the map-reduce generation arm. Never throws for content reasons (adr §5). */
export async function runMapReduce(
  params: MapReduceParams,
): Promise<MapReduceResult> {
  const { deps, meta, turns, type, callDate, weekday, transcriptText } = params;
  const { router, config, logger } = deps;
  const usage: JobUsage[] = [];

  const chunks = chunkTurns(turns, {
    mapChunkTokens: config.mapChunkTokens,
    mapOverlapRatio: config.mapOverlapRatio,
  });

  // MAP — sequential over chunks. Parallel fan-out is a deliberate v1 omission
  // (the router is one shared seam); revisit if map latency ever dominates.
  const chunkResults: ChunkFacts[] = [];
  for (const chunk of chunks) {
    const segment = formatTranscript(chunk.turns);
    const ladder = await runLadder({
      schema: chunkFactsSchema,
      messages: buildMapMessages({
        segment,
        chunkIndex: chunk.index,
        chunkCount: chunks.length,
        callDate,
        weekday,
      }),
      router,
      repair: (invalidText, issues) => buildMapRepairMessages(invalidText, issues),
    });
    usage.push(...ladder.usage);
    if (ladder.result.status === "ok") {
      chunkResults.push(ladder.result.value);
    } else {
      // A chunk that exhausts the ladder contributes empty facts — never aborts
      // the whole meeting (adr §5).
      chunkResults.push(EMPTY_CHUNK_FACTS);
      logger.info(
        { meeting_id: meta.id, chunk: chunk.index },
        "notes.mapreduce.chunk_fallback",
      );
    }
  }
  logger.info(
    { meeting_id: meta.id, chunks: chunks.length, map_calls: usage.length },
    "notes.mapreduce.map_complete",
  );

  // REDUCE (merge in code) — dedup facts by normalized text, first (earliest) wins.
  const mergedDecisions = dedupDecisions(chunkResults.flatMap((c) => c.decisions));
  const mergedActionItems = dedupActionItems(
    chunkResults.flatMap((c) => c.actionItems),
  );
  const mergedOpenQuestions = dedupStrings(
    chunkResults.flatMap((c) => c.openQuestions),
  );
  const mergedRisks = dedupStrings(chunkResults.flatMap((c) => c.risks));
  const mergedInsights = {
    objections: dedupStrings(chunkResults.flatMap((c) => c.insights.objections)),
    buyingSignals: dedupStrings(
      chunkResults.flatMap((c) => c.insights.buyingSignals),
    ),
    questionsAsked: dedupStrings(
      chunkResults.flatMap((c) => c.insights.questionsAsked),
    ),
    answersToRevisit: dedupStrings(
      chunkResults.flatMap((c) => c.insights.answersToRevisit),
    ),
  };
  const summaries = chunkResults
    .map((c) => c.miniSummary)
    .filter((s) => s.trim() !== "");

  const facts: ReduceFacts = {
    summaries,
    decisions: mergedDecisions.map((d) => d.text),
    actionItems: mergedActionItems.map((a) => a.text),
    openQuestions: mergedOpenQuestions,
    risks: mergedRisks,
    ...mergedInsights,
  };

  const reduceLadder = await runLadder({
    schema: reduceRequestSchema(type),
    messages: buildReduceMessages({ type, facts, callDate, weekday }),
    router,
    repair: (invalidText, issues) =>
      buildReduceRepairMessages(type, invalidText, issues),
  });
  usage.push(...reduceLadder.usage);

  const hasContent =
    summaries.length > 0 ||
    mergedDecisions.length > 0 ||
    mergedActionItems.length > 0 ||
    mergedOpenQuestions.length > 0 ||
    mergedRisks.length > 0;

  // Reduce exhausted AND nothing to salvage → the deterministic fallback constant.
  if (reduceLadder.result.status !== "ok" && !hasContent) {
    logger.info({ meeting_id: meta.id }, "notes.mapreduce.reduce_fallback_empty");
    return {
      notes: buildFallbackNotes(meta.title),
      usage,
      rawText: reduceLadder.rawText,
    };
  }

  let rawText: string | undefined;
  let narrative: { title: string; tldr: string; overview: string };
  let openQuestions: string[];
  let risks: string[];
  let typeInsights: TypeInsightsContent;

  if (reduceLadder.result.status === "ok") {
    const reduced = reduceLadder.result.value;
    narrative = {
      title: reduced.title,
      tldr: reduced.tldr,
      overview: reduced.overview,
    };
    openQuestions = reduced.openQuestions;
    risks = reduced.risks;
    typeInsights = reduced.typeInsights;
  } else {
    // Facts exist but the narrative call failed: assemble prose deterministically
    // from the ordered summaries + merged facts (facts are never lost).
    rawText = reduceLadder.rawText;
    narrative = deterministicNarrative(meta, summaries);
    openQuestions = mergedOpenQuestions;
    risks = mergedRisks;
    typeInsights = insightsFor(type, mergedInsights);
    logger.info({ meeting_id: meta.id }, "notes.mapreduce.reduce_fallback");
  }

  // The whole map/reduce pipeline works in id-LESS content terms (both model calls
  // produce content); ids are minted exactly once, here, at assembly (v2 —
  // docs/DESIGN/live-notes.md §2). The model never chooses an item's identity.
  const content: NotesContent = {
    conversationType: type,
    title: narrative.title,
    tldr: narrative.tldr,
    overview: narrative.overview,
    decisions: mergedDecisions,
    actionItems: mergedActionItems,
    openQuestions,
    risks,
    typeInsights,
  };
  const assembled: MeetingNotes = identifyNotes(content, "generated");

  const notes = verifyNotes(assembled, transcriptText);
  return rawText !== undefined ? { notes, usage, rawText } : { notes, usage };
}
