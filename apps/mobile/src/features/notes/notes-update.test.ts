import { describe, expect, it } from 'vitest';
import { buildFallbackNotes, type MeetingNotes } from '@nova/shared';

import {
  applyNotesUpdate,
  emptyLiveNotes,
  markLiveNotesSeen,
  type LiveNotesState,
} from './notes-update';

/**
 * The `notes.update` rev rule (§5.3). This is the first test in `apps/mobile` — the
 * workspace had no test infrastructure before Phase 8.5 — and it is deliberately the
 * rule the wire protocol has documented since Phase 8 with nothing implementing it.
 */

function notes(tldr: string): MeetingNotes {
  return { ...buildFallbackNotes('Call'), tldr, source: 'live' };
}

const at = (rev: number, tldr = `rev ${String(rev)}`) => ({
  notes: notes(tldr),
  rev,
});

describe('applyNotesUpdate', () => {
  it('applies the first update from empty state', () => {
    const next = applyNotesUpdate(emptyLiveNotes, at(1), true);

    expect(next.rev).toBe(1);
    expect(next.notes?.tldr).toBe('rev 1');
  });

  it('applies a strictly newer rev', () => {
    const first = applyNotesUpdate(emptyLiveNotes, at(3), true);
    const next = applyNotesUpdate(first, at(4), true);

    expect(next.rev).toBe(4);
    expect(next.notes?.tldr).toBe('rev 4');
  });

  it('DROPS a lower rev — notes must never go backwards', () => {
    // The reconnect case: the server re-emits and an older payload arrives late.
    const first = applyNotesUpdate(emptyLiveNotes, at(7), true);
    const next = applyNotesUpdate(first, at(2), true);

    expect(next.rev).toBe(7);
    expect(next.notes?.tldr).toBe('rev 7');
  });

  it('DROPS an equal rev', () => {
    // A re-emitted rev carries the same state by definition. Treating `=` as newer
    // would make the guard depend on delivery order — the thing it exists to be
    // independent of.
    const first = applyNotesUpdate(emptyLiveNotes, at(5, 'original'), true);
    const next = applyNotesUpdate(first, at(5, 'duplicate'), true);

    expect(next.notes?.tldr).toBe('original');
  });

  it('returns the SAME reference when it drops, so React skips the re-render', () => {
    const first = applyNotesUpdate(emptyLiveNotes, at(7), true);
    expect(applyNotesUpdate(first, at(7), true)).toBe(first);
    expect(applyNotesUpdate(first, at(1), true)).toBe(first);
  });

  it('accepts rev 0 as a first update', () => {
    // rev is nonnegative, and the guard keys off `rev === null`, not falsiness — a
    // `!state.rev` check here would silently re-apply every rev-0 payload.
    const next = applyNotesUpdate(emptyLiveNotes, at(0), true);

    expect(next.rev).toBe(0);
    expect(next.notes).not.toBeNull();
  });

  it('does not drop rev 1 after a rev 0 first update', () => {
    const first = applyNotesUpdate(emptyLiveNotes, at(0), true);
    const next = applyNotesUpdate(first, at(1), true);

    expect(next.rev).toBe(1);
  });
});

describe('unread tracking', () => {
  it('marks unseen when the panel is hidden', () => {
    const next = applyNotesUpdate(emptyLiveNotes, at(1), false);
    expect(next.hasUnseen).toBe(true);
  });

  it('does not mark unseen when the user is watching', () => {
    const next = applyNotesUpdate(emptyLiveNotes, at(1), true);
    expect(next.hasUnseen).toBe(false);
  });

  it('keeps the flag across further hidden updates', () => {
    let state: LiveNotesState = applyNotesUpdate(emptyLiveNotes, at(1), false);
    state = applyNotesUpdate(state, at(2), false);
    expect(state.hasUnseen).toBe(true);
  });

  it('a DROPPED update does not raise the flag', () => {
    // Otherwise a stale re-delivery would light the dot with nothing behind it.
    const seen = applyNotesUpdate(emptyLiveNotes, at(5), true);
    const next = applyNotesUpdate(seen, at(3), false);

    expect(next.hasUnseen).toBe(false);
  });

  it('clears on markLiveNotesSeen, and is a no-op when already clear', () => {
    const unseen = applyNotesUpdate(emptyLiveNotes, at(1), false);
    const seen = markLiveNotesSeen(unseen);

    expect(seen.hasUnseen).toBe(false);
    expect(seen.notes).toBe(unseen.notes);
    expect(markLiveNotesSeen(seen)).toBe(seen);
  });
});
