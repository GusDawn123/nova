import {
  NOTE_ID_PREFIX,
  meetingNotesSchema,
  type MeetingNotes,
  type NoteListKey,
} from "@nova/shared";

import { normalizeForMatch } from "./verify-quotes.js";

/**
 * Live→final id reconciliation (Phase 8, docs/DESIGN/live-notes.md §3).
 *
 * At call end the authoritative post-call notes replace the live preview. Done
 * naively that swap IS the forbidden teleport, deferred to the exact moment the
 * user is most likely watching: an hour of accrued, id-stable items would blink
 * out and be replaced by a visually identical list under brand-new ids, so the
 * client's diff would show "everything changed".
 *
 * This pass matches each FINAL item back to the live item it evidently came from
 * and carries the LIVE id onto it. Retained items keep their identity, genuinely
 * new items mint fresh, and the client animates a real diff instead of a wipe.
 *
 * PURE, and it touches no LLM path — the post-call pipeline's prompts, schemas,
 * and accuracy gates are entirely unaffected. (Seeding the post-call reduce with
 * the live notes would be cheaper still and probably higher quality, but it
 * changes the map-reduce contract; deferred, per §3.)
 */

/**
 * Jaccard similarity at or above which a final item is "the same item" as a live
 * one. 0.6 mirrors the speculation reconcile threshold: high enough that two
 * genuinely different action items do not merge, low enough to survive the
 * rewording the post-call pass inevitably applies to a mid-call phrasing.
 */
export const RECONCILE_THRESHOLD = 0.6;

/** Lowercased word set, over the same normalization the quote check uses. */
function wordSet(text: string): Set<string> {
  return new Set(
    normalizeForMatch(text)
      .replace(/[^a-z0-9'\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 0),
  );
}

/**
 * Jaccard overlap of the two texts' word sets, 0..1.
 *
 * EXPORTED because "is this the same item?" must have exactly one definition here.
 * Two callers ask it: this module, reconciling live ids onto post-call items at the
 * hangup swap, and `item-completion.ts`, deciding whether a stored checkmark still
 * belongs to the item now sitting at its id after a regenerate. Those are the same
 * question about the same data, and answering it two slightly different ways is how
 * a checkmark ends up on a task the user never finished.
 */
export function similarity(a: string, b: string): number {
  const sa = wordSet(a);
  const sb = wordSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const word of sa) {
    if (sb.has(word)) intersection += 1;
  }
  return intersection / (sa.size + sb.size - intersection);
}

/** The shape every itemized list entry shares. */
interface TextItem {
  readonly id: string;
  readonly text: string;
}

/** The numeric suffix of a minted id (`d12` → 12); 0 when it has none. */
function seqOf(id: string): number {
  const match = /(\d+)$/.exec(id);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

/**
 * Reconcile ONE list. Exact normalized matches are taken first, in a full pass,
 * so a near-duplicate cannot steal the id of an item that matched perfectly;
 * everything left over then takes its best similarity match above the threshold.
 */
function reconcileList<T extends TextItem>(
  liveItems: readonly TextItem[],
  finalItems: readonly T[],
  list: NoteListKey,
  threshold: number,
): T[] {
  const claimed = new Set<string>();
  const assigned = new Map<number, string>();

  const takeIf = (
    finalIndex: number,
    predicate: (live: TextItem) => boolean,
  ): void => {
    if (assigned.has(finalIndex)) return;
    const item = finalItems[finalIndex];
    if (item === undefined) return;
    const match = liveItems.find(
      (live) => !claimed.has(live.id) && predicate(live),
    );
    if (match === undefined) return;
    claimed.add(match.id);
    assigned.set(finalIndex, match.id);
  };

  // Pass 1 — exact normalized text.
  finalItems.forEach((item, i) => {
    const target = normalizeForMatch(item.text);
    takeIf(i, (live) => normalizeForMatch(live.text) === target);
  });

  // Pass 2 — best remaining similarity above the threshold.
  finalItems.forEach((item, i) => {
    if (assigned.has(i)) return;
    let best: { id: string; score: number } | null = null;
    for (const live of liveItems) {
      if (claimed.has(live.id)) continue;
      const score = similarity(item.text, live.text);
      if (score >= threshold && (best === null || score > best.score)) {
        best = { id: live.id, score };
      }
    }
    if (best !== null) {
      claimed.add(best.id);
      assigned.set(i, best.id);
    }
  });

  // Fresh ids start ABOVE every id carried over, so a mint can never collide
  // with a retained item's identity.
  let next = 0;
  for (const id of assigned.values()) next = Math.max(next, seqOf(id));

  return finalItems.map((item, i) => {
    const carried = assigned.get(i);
    if (carried !== undefined) return { ...item, id: carried };
    next += 1;
    return { ...item, id: `${NOTE_ID_PREFIX[list]}${String(next)}` };
  });
}

/** The itemized lists of a notes object as `[key, items]` pairs. */
function listsOf(notes: MeetingNotes): Map<NoteListKey, readonly TextItem[]> {
  const map = new Map<NoteListKey, readonly TextItem[]>([
    ["decisions", notes.decisions],
    ["actionItems", notes.actionItems],
    ["openQuestions", notes.openQuestions],
    ["risks", notes.risks],
  ]);
  const insights = notes.typeInsights;
  if (insights.kind === "sales") {
    map.set("objections", insights.objections);
    map.set("buyingSignals", insights.buyingSignals);
  } else if (insights.kind === "interview") {
    map.set("questionsAsked", insights.questionsAsked);
    map.set("answersToRevisit", insights.answersToRevisit);
  }
  return map;
}

/**
 * Carry live ids onto the matching items of the authoritative final notes.
 *
 * Matching is per-list: an id never migrates between lists, and an arm the live
 * notes never had (the call was still `casual` when it ended) simply mints fresh.
 * `live === null` returns `final` untouched.
 */
export function reconcileIds(
  live: MeetingNotes | null,
  final: MeetingNotes,
  threshold: number = RECONCILE_THRESHOLD,
): MeetingNotes {
  if (live === null) return final;

  const liveLists = listsOf(live);
  const pick = (list: NoteListKey): readonly TextItem[] =>
    liveLists.get(list) ?? [];

  const insights = final.typeInsights;
  const arm =
    insights.kind === "sales"
      ? {
          kind: "sales" as const,
          objections: reconcileList(
            pick("objections"),
            insights.objections,
            "objections",
            threshold,
          ),
          buyingSignals: reconcileList(
            pick("buyingSignals"),
            insights.buyingSignals,
            "buyingSignals",
            threshold,
          ),
        }
      : insights.kind === "interview"
        ? {
            kind: "interview" as const,
            questionsAsked: reconcileList(
              pick("questionsAsked"),
              insights.questionsAsked,
              "questionsAsked",
              threshold,
            ),
            answersToRevisit: reconcileList(
              pick("answersToRevisit"),
              insights.answersToRevisit,
              "answersToRevisit",
              threshold,
            ),
          }
        : insights;

  const candidate: unknown = {
    ...final,
    decisions: reconcileList(
      pick("decisions"),
      final.decisions,
      "decisions",
      threshold,
    ),
    actionItems: reconcileList(
      pick("actionItems"),
      final.actionItems,
      "actionItems",
      threshold,
    ),
    openQuestions: reconcileList(
      pick("openQuestions"),
      final.openQuestions,
      "openQuestions",
      threshold,
    ),
    risks: reconcileList(pick("risks"), final.risks, "risks", threshold),
    typeInsights: arm,
  };

  // This pass only rewrites ids, so a failure here would be a bug in this file.
  // The authoritative notes are far too important to risk on that: fall back to
  // the un-reconciled final rather than emit anything invalid.
  const parsed = meetingNotesSchema.safeParse(candidate);
  return parsed.success ? parsed.data : final;
}
