import {
  NOTE_ID_PREFIX,
  meetingNotesSchema,
  type ConversationType,
  type MeetingNotes,
  type NoteListKey,
} from "@nova/shared";

import { validateItem, type FoldResult } from "./live-fold-ops.js";
import {
  ARM_LISTS,
  activeLists,
  listEntries,
  seqOf,
  type DroppedOp,
  type FoldContext,
  type FoldOutcome,
  type Identified,
} from "./live-fold-state.js";
import { verifyNotes } from "./verify-quotes.js";

/**
 * The live-notes fold (Phase 8, docs/DESIGN/live-notes.md §3). Pure, synchronous,
 * fully unit-testable — and the place the "never teleport" guarantee ACTUALLY
 * lives. Every rule below is a server-side clamp, not a prompt instruction: a
 * prompt is a request, and this reducer is what happens when the model ignores it.
 *
 * The model proposes OPS (`add`/`update`/`retract`) against a digest of the prior
 * notes; the server owns the state, the ids, and the ordering. That inversion is
 * what makes the whole feature affordable and stable — output cost stops scaling
 * with total note count, and the model structurally cannot rewrite an item it was
 * never shown.
 *
 * NEVER THROWS. Adversarial model output (unknown ids, duplicate ids, ops against
 * a list the conversation type does not have, wholesale rewrites, reshuffles) is
 * clamped and reported in `dropped`, never raised. The final object is re-parsed
 * against `meetingNotesSchema`; if even that fails, the prior notes are returned
 * unchanged rather than emitting something invalid.
 *
 * The model contract lives in `live-fold-ops.ts`; the state and latches in
 * `live-fold-state.ts`. Both are re-exported below so consumers keep ONE entry
 * point for the fold.
 */

export {
  MAX_OPS_PER_FOLD,
  foldResultSchema,
  type FoldResult,
} from "./live-fold-ops.js";
export {
  LIVE_FORMING_TLDR,
  deriveSeqCounters,
  emptyLiveNotes,
  initialFoldState,
  type DroppedOp,
  type FoldContext,
  type FoldOutcome,
  type FoldState,
  type LiveFoldConfig,
  type SeqCounters,
} from "./live-fold-state.js";

// ---------------------------------------------------------------------------

/**
 * Fold the model's ops into the prior notes. See the module docblock; the ten
 * clamps are inline below, each tagged with its rule number from the design doc.
 */
export function applyFold(
  prior: MeetingNotes,
  model: FoldResult,
  ctx: FoldContext,
): FoldOutcome {
  const dropped: DroppedOp[] = [];

  // RULE 9 — conversation-type latch. `casual → typed` once, past the classify
  // threshold; anything else is ignored. A mid-call `sales → interview` flip would
  // replace the whole typeInsights arm and drop every accrued objection.
  const type = latchType(prior.conversationType, model.conversationType, ctx);
  const typeChanged = type !== prior.conversationType;

  // A type change swaps the arm; base lists survive it untouched.
  const lists = new Map<NoteListKey, Identified[]>();
  for (const [key, items] of listEntries(prior)) lists.set(key, [...items]);
  if (typeChanged) {
    for (const key of ARM_LISTS[prior.conversationType]) lists.delete(key);
    for (const key of ARM_LISTS[type]) lists.set(key, []);
  }

  const legal = new Set<string>(activeLists(type));
  const seq: Record<NoteListKey, number> = { ...ctx.state.seq };
  // RULE 1 — the churn ceiling is computed from the PRIOR list lengths, so a fold
  // cannot grow a list and then spend the larger budget on it in the same pass.
  const budget = new Map<NoteListKey, number>();
  for (const [key, items] of lists) {
    budget.set(
      key,
      Math.max(
        ctx.config.maxChurnPerFold,
        Math.ceil(items.length * ctx.config.churnFraction),
      ),
    );
  }
  const churnUsed = new Map<NoteListKey, number>();
  const touched = new Set<string>();
  let applied = 0;

  for (const op of model.ops ?? []) {
    if (!legal.has(op.list)) {
      dropped.push({
        op: op.op,
        list: op.list,
        ...("id" in op ? { id: op.id } : {}),
        reason: isNoteListKey(op.list) ? "list_not_in_type" : "unknown_list",
      });
      continue;
    }
    const list = op.list as NoteListKey;
    const items = lists.get(list) ?? [];

    if (op.op === "add") {
      // RULE 7 — per-list cap. At cap the prompt asks the model to consolidate
      // via `update` instead; here the add simply does not land.
      if (items.length >= ctx.config.maxItemsPerList) {
        dropped.push({ op: "add", list, reason: "list_at_cap" });
        continue;
      }
      const item = validateItem(list, op.item);
      if (item === null) {
        dropped.push({ op: "add", list, reason: "invalid_item" });
        continue;
      }
      // RULE 4 — `add` mints from the per-list counter; the model never supplies
      // an id, so it cannot collide with or resurrect one.
      const next = seq[list] + 1;
      seq[list] = next;
      items.push({ ...item, id: `${NOTE_ID_PREFIX[list]}${String(next)}` });
      lists.set(list, items);
      applied += 1;
      continue;
    }

    // RULE 3 — duplicate echoed ids: the first op that LANDS wins, the rest drop.
    if (touched.has(op.id)) {
      dropped.push({ op: op.op, list, id: op.id, reason: "duplicate_id" });
      continue;
    }
    // RULE 2 — id reuse by echo. An update against an id the model was never
    // shown is a hallucination, not an addition: it is dropped, never minted.
    const index = items.findIndex((item) => item.id === op.id);
    if (index === -1) {
      dropped.push({ op: op.op, list, id: op.id, reason: "unknown_id" });
      continue;
    }

    if (op.op === "update") {
      const item = validateItem(list, op.item);
      // Validated BEFORE the churn budget is charged, so a malformed update does
      // not consume a slot a good one could have used.
      if (item === null) {
        dropped.push({ op: "update", list, id: op.id, reason: "invalid_item" });
        continue;
      }
      if (!chargeChurn(list, budget, churnUsed)) {
        dropped.push({ op: "update", list, id: op.id, reason: "churn_ceiling" });
        continue;
      }
      // The id is CARRIED, never re-minted — that is what makes this an update the
      // client can animate rather than a delete plus an insert.
      items[index] = { ...item, id: op.id };
    } else {
      if (!chargeChurn(list, budget, churnUsed)) {
        dropped.push({ op: "retract", list, id: op.id, reason: "churn_ceiling" });
        continue;
      }
      // RULE 6 — retraction ONLY on an explicit retract op. An item the model
      // simply omitted from its response is retained, always.
      items.splice(index, 1);
    }
    touched.add(op.id);
    lists.set(list, items);
    applied += 1;
  }

  // RULE 5 — order is server-owned: items sort by MINT SEQUENCE, never by the
  // model's array order, so a reshuffled response cannot reorder the user's list.
  for (const [key, items] of lists) {
    lists.set(
      key,
      [...items].sort((a, b) => seqOf(a.id) - seqOf(b.id)),
    );
  }

  // RULE 8 — narrative gating. Rewriting tldr/overview ~144×/hour reads as churn
  // no matter how it is animated, so it only lands on an open window.
  const narrative = resolveNarrative(prior, model, ctx, typeChanged);

  const changed = applied > 0 || typeChanged || narrative.changed;
  if (!changed) {
    return { notes: prior, changed: false, dropped, state: ctx.state };
  }

  const candidate: unknown = {
    ...prior,
    conversationType: type,
    title: narrative.title,
    tldr: narrative.tldr,
    overview: narrative.overview,
    decisions: lists.get("decisions") ?? [],
    actionItems: lists.get("actionItems") ?? [],
    openQuestions: lists.get("openQuestions") ?? [],
    risks: lists.get("risks") ?? [],
    typeInsights: assembleInsights(type, lists),
    source: "live" as const,
  };

  // Belt and braces: the reducer's internal lists are loosely typed, so the result
  // is re-parsed before it can escape. A failure here is a bug in THIS file, not
  // hostile input — but the contract is "never emit an invalid object", so the
  // prior notes stand and the fold reports no change.
  const parsed = meetingNotesSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      notes: prior,
      changed: false,
      dropped: [
        ...dropped,
        { op: "add", list: "(result)", reason: "invalid_result" },
      ],
      state: ctx.state,
    };
  }

  // RULE 10 — the same pure quote check the post-call path runs, so a live item
  // and its final counterpart carry identical `unverified` semantics.
  const notes = verifyNotes(parsed.data, ctx.transcriptSoFar);

  return {
    notes,
    changed: true,
    dropped,
    state: {
      seq,
      titleLatched: ctx.state.titleLatched || narrative.titleSet,
      typeLatched: ctx.state.typeLatched || typeChanged,
    },
  };
}

/** Spend one unit of a list's churn budget; false when it is exhausted. */
function chargeChurn(
  list: NoteListKey,
  budget: Map<NoteListKey, number>,
  used: Map<NoteListKey, number>,
): boolean {
  const spent = used.get(list) ?? 0;
  if (spent >= (budget.get(list) ?? 0)) return false;
  used.set(list, spent + 1);
  return true;
}

function isNoteListKey(value: string): value is NoteListKey {
  return Object.hasOwn(NOTE_ID_PREFIX, value);
}

/** RULE 9's transition table, isolated so it reads as the rule it implements. */
function latchType(
  current: ConversationType,
  proposed: ConversationType | undefined,
  ctx: FoldContext,
): ConversationType {
  if (proposed === undefined || proposed === current) return current;
  if (ctx.state.typeLatched || !ctx.canLatchType) return current;
  // Only ever casual → typed, and only once.
  if (current !== "casual" || proposed === "casual") return current;
  return proposed;
}

/** RULE 8's narrative resolution: window gating plus the title latch. */
function resolveNarrative(
  prior: MeetingNotes,
  model: FoldResult,
  ctx: FoldContext,
  typeChanged: boolean,
): {
  title: string;
  tldr: string;
  overview: string;
  changed: boolean;
  titleSet: boolean;
} {
  const base = {
    title: prior.title,
    tldr: prior.tldr,
    overview: prior.overview,
    changed: false,
    titleSet: false,
  };
  if (!ctx.narrativeOpen || model.narrative === undefined) return base;

  const { title, tldr, overview } = model.narrative;
  const next = { ...base };

  // The title is LATCHED after its first real value — a call's name should settle
  // early and stay put. A conversation-type change is the one thing that reopens it.
  if (
    title !== undefined &&
    title.trim() !== "" &&
    (!ctx.state.titleLatched || typeChanged)
  ) {
    next.title = title.trim();
    next.titleSet = true;
    next.changed ||= next.title !== prior.title;
  }
  if (tldr !== undefined && tldr.trim() !== "" && tldr.trim() !== prior.tldr) {
    next.tldr = tldr.trim();
    next.changed = true;
  }
  if (
    overview !== undefined &&
    overview.trim() !== "" &&
    overview.trim() !== prior.overview
  ) {
    next.overview = overview.trim();
    next.changed = true;
  }
  return next;
}

/**
 * Rebuild the `typeInsights` arm for `type` from the working lists. Returns a
 * plain object rather than a typed arm: the working lists are loosely typed by
 * design, and `meetingNotesSchema.safeParse` in {@link applyFold} is what proves
 * the shape. Casting here instead would move that proof to compile time, where it
 * would be a lie.
 */
function assembleInsights(
  type: ConversationType,
  lists: Map<NoteListKey, Identified[]>,
): Record<string, unknown> {
  if (type === "sales") {
    return {
      kind: "sales",
      objections: lists.get("objections") ?? [],
      buyingSignals: lists.get("buyingSignals") ?? [],
    };
  }
  if (type === "interview") {
    return {
      kind: "interview",
      questionsAsked: lists.get("questionsAsked") ?? [],
      answersToRevisit: lists.get("answersToRevisit") ?? [],
    };
  }
  return { kind: "casual" };
}
