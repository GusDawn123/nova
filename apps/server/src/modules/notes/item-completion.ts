import type { MeetingNotes } from "@nova/shared";

import { RECONCILE_THRESHOLD, similarity } from "./reconcile-ids.js";

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
 * as the item now at that id, judged by the same jaccard threshold `reconcile-ids.ts`
 * uses for the live→final swap. Rewording survives ("Send the scope comparison" →
 * "Send the scope comparison to Dana"); replacement does not ("Confirm SSO scope").
 * Either way the state self-heals: a dropped checkmark simply renders unchecked, and
 * the user can re-check it.
 */

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
 * and {@link similarity} returns 1 for it, so one comparison covers both. The
 * threshold is imported rather than redeclared — if the reconcile bar ever moves,
 * this must move with it or the two answers diverge.
 */
export function isSameItem(rememberedText: string, currentText: string): boolean {
  return similarity(rememberedText, currentText) >= RECONCILE_THRESHOLD;
}
