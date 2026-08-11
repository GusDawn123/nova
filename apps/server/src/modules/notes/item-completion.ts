import type { MeetingNotes } from "@nova/shared";

import { normalizeForMatch } from "./verify-quotes.js";

/**
 * Action-item completion: which stored checkmarks still belong to the notes as they
 * read RIGHT NOW (Phase 8.5, `docs/DESIGN/notes-ui.md` §6.3). PURE — no I/O, no
 * clock, no throw.
 *
 * The problem this exists to solve is identity, not storage. Note ids (`a1`, `a2`,
 * …) are positional counters minted server-side, and `POST /notes/regenerate` re-runs
 * the whole pipeline, so the item at `a2` afterwards need not be the item at `a2`
 * before. A completion keyed on the id alone would move a user's checkmark onto a
 * different task — worse than losing it, because it reads as a claim the user made.
 *
 * So a stored row counts only while its remembered text still MEANS the same thing
 * as the item now at that id, judged by the jaccard threshold below. Rewording
 * survives ("Send the scope comparison" → "Send the scope comparison to Dana");
 * replacement does not ("Confirm SSO scope"). Either way the state self-heals: a
 * dropped checkmark simply renders unchecked, and the user can re-check it.
 */

/**
 * Jaccard similarity at or above which the item at an id is "the same item" a
 * stored checkmark remembers. 0.6 mirrors the speculation reconcile threshold:
 * high enough that two genuinely different action items do not merge, low enough
 * to survive the rewording a regenerate inevitably applies.
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

/** Jaccard overlap of the two texts' word sets, 0..1. */
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

/** One stored completion row, as the DB seam hands it over. */
export interface StoredItemState {
  readonly itemId: string;
  /** The item's text at the moment the user acted on it. */
  readonly itemText: string;
  /** Null means explicitly unchecked — a durable fact, not an absence. */
  readonly completedAt: string | null;
}

/**
 * The ids whose stored completion still applies to `notes`.
 *
 * Only ACTION ITEMS are considered: they are the only list the product presents as
 * checkable, and admitting other prefixes would let a stale `d1` row light up a
 * decision the UI never offered a checkbox for.
 *
 * Returns ids in the notes' own action-item order, so the response is stable across
 * calls and diffable by a client.
 */
export function completedItemIds(
  notes: MeetingNotes | null,
  stored: readonly StoredItemState[],
): string[] {
  if (notes === null) return [];

  const byId = new Map<string, StoredItemState>();
  for (const row of stored) {
    if (row.completedAt !== null) byId.set(row.itemId, row);
  }
  if (byId.size === 0) return [];

  const out: string[] = [];
  for (const item of notes.actionItems) {
    const row = byId.get(item.id);
    if (row === undefined) continue;
    if (isSameItem(row.itemText, item.text)) out.push(item.id);
  }
  return out;
}

/**
 * Whether a remembered text and the current text are the same item.
 *
 * Exact-after-normalization is the overwhelmingly common case (nothing regenerated),
 * and {@link similarity} returns 1 for it, so one comparison covers both.
 */
export function isSameItem(rememberedText: string, currentText: string): boolean {
  return similarity(rememberedText, currentText) >= RECONCILE_THRESHOLD;
}
