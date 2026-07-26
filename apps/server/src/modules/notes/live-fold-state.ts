import type { ConversationType, MeetingNotes, NoteListKey } from "@nova/shared";

import type { ValidatedItem } from "./live-fold-ops.js";

/**
 * The live fold's SHARED TYPES AND STATE: which lists exist for a conversation
 * type, the per-list mint counters, the latches threaded across folds, the
 * config and context the reducer takes, and the empty notes a call starts from.
 *
 * Split out of `live-fold.ts` so that file holds only the CLAMPS (RULES §2 — the
 * fold outgrew the ~400-line cap once all ten rules landed).
 */

/** Lists every conversation type carries. */
export const BASE_LISTS = [
  "decisions",
  "actionItems",
  "openQuestions",
  "risks",
] as const satisfies readonly NoteListKey[];

/** The `typeInsights` arm lists, by conversation type. */
export const ARM_LISTS: Record<ConversationType, readonly NoteListKey[]> = {
  sales: ["objections", "buyingSignals"],
  interview: ["questionsAsked", "answersToRevisit"],
  casual: [],
};

/** Which lists an op may legally target for a given conversation type. */
export function activeLists(type: ConversationType): readonly NoteListKey[] {
  return [...BASE_LISTS, ...ARM_LISTS[type]];
}

/** Per-list mint counters. Monotonic — a retracted id is never handed out again. */
export type SeqCounters = Readonly<Record<NoteListKey, number>>;

/** The latches the conductor threads across folds (pure — nothing is mutated). */
export interface FoldState {
  readonly seq: SeqCounters;
  /** A narrative has supplied a real title; later folds may not overwrite it. */
  readonly titleLatched: boolean;
  /** The one permitted `casual → typed` transition has been spent. */
  readonly typeLatched: boolean;
}

export interface LiveFoldConfig {
  /** Floor on how many existing items ONE fold may touch, per list. */
  readonly maxChurnPerFold: number;
  /** …or this fraction of the list, whichever is larger. */
  readonly churnFraction: number;
  /** Hard per-list item cap. Bounds a 3-hour call. */
  readonly maxItemsPerList: number;
}

export interface FoldContext {
  readonly config: LiveFoldConfig;
  readonly state: FoldState;
  /** Is the narrative window open on THIS fold (§4)? Closed → narrative ignored. */
  readonly narrativeOpen: boolean;
  /** Transcript so far, for the same quote check the post-call path runs. */
  readonly transcriptSoFar: string;
  /** Past the classify threshold — below it, no type transition is honoured. */
  readonly canLatchType: boolean;
}

/** Why one op did not land. Cue names and ids only — NEVER item text (RULES §6). */
export interface DroppedOp {
  readonly op: "add" | "update" | "retract";
  readonly list: string;
  readonly id?: string;
  readonly reason:
    | "unknown_list"
    | "list_not_in_type"
    | "unknown_id"
    | "duplicate_id"
    | "churn_ceiling"
    | "list_at_cap"
    | "invalid_item"
    | "invalid_result";
}

export interface FoldOutcome {
  readonly notes: MeetingNotes;
  /** False when every op was dropped — no rev bump, no wire event, no write. */
  readonly changed: boolean;
  readonly dropped: readonly DroppedOp[];
  readonly state: FoldState;
}

/** A validated item once the server has minted (or carried) its id. */
export type Identified = ValidatedItem & { id: string };

// ---------------------------------------------------------------------------
// Seeds and derivations
// ---------------------------------------------------------------------------

/** Shown until the first narrative fold replaces it. */
export const LIVE_FORMING_TLDR = "Notes are still forming.";
const LIVE_FORMING_OVERVIEW =
  "This call is in progress. These notes update as it goes.";

const ZERO_SEQ: SeqCounters = {
  decisions: 0,
  actionItems: 0,
  openQuestions: 0,
  risks: 0,
  objections: 0,
  buyingSignals: 0,
  questionsAsked: 0,
  answersToRevisit: 0,
};

/** The base a call starts from before its first fold: valid, empty, `source:"live"`. */
export function emptyLiveNotes(title: string): MeetingNotes {
  const safeTitle = title.trim() === "" ? "Untitled call" : title;
  return {
    version: 2,
    conversationType: "casual",
    title: safeTitle,
    tldr: LIVE_FORMING_TLDR,
    overview: LIVE_FORMING_OVERVIEW,
    decisions: [],
    actionItems: [],
    openQuestions: [],
    risks: [],
    typeInsights: { kind: "casual" },
    source: "live",
  };
}

/** The numeric suffix of a minted id (`d12` → 12); 0 when it has none. */
export function seqOf(id: string): number {
  const match = /(\d+)$/.exec(id);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

/**
 * Rebuild the mint counters from a stored notes object — used ONCE at hydration,
 * when the in-memory counters are gone (a fresh session over an existing row).
 *
 * Known limitation, accepted: across that boundary an id retracted in a previous
 * session can be re-minted, because a retracted item leaves no trace in the stored
 * notes. Ids only need to be stable WITHIN a session for the client's diff to
 * animate, and hydration happens once at session start.
 */
export function deriveSeqCounters(notes: MeetingNotes | null): SeqCounters {
  if (notes === null) return ZERO_SEQ;
  const seq: Record<NoteListKey, number> = { ...ZERO_SEQ };
  for (const [list, items] of listEntries(notes)) {
    seq[list] = items.reduce((max, item) => Math.max(max, seqOf(item.id)), 0);
  }
  return seq;
}

/** The starting latch state for a hydrated (or brand new) notes object. */
export function initialFoldState(notes: MeetingNotes | null): FoldState {
  return {
    seq: deriveSeqCounters(notes),
    titleLatched: notes !== null && notes.tldr !== LIVE_FORMING_TLDR,
    typeLatched: notes !== null && notes.conversationType !== "casual",
  };
}

/** Every itemized list of a notes object, as `[key, items]` pairs. */
export function listEntries(notes: MeetingNotes): [NoteListKey, Identified[]][] {
  const entries: [NoteListKey, Identified[]][] = [
    ["decisions", notes.decisions],
    ["actionItems", notes.actionItems],
    ["openQuestions", notes.openQuestions],
    ["risks", notes.risks],
  ];
  const insights = notes.typeInsights;
  if (insights.kind === "sales") {
    entries.push(["objections", insights.objections]);
    entries.push(["buyingSignals", insights.buyingSignals]);
  } else if (insights.kind === "interview") {
    entries.push(["questionsAsked", insights.questionsAsked]);
    entries.push(["answersToRevisit", insights.answersToRevisit]);
  }
  return entries;
}
