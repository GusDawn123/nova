import { describe, expect, it } from 'vitest';

import {
  emptySteerPairing,
  pairSteerArrivals,
  steerSubmitted,
} from './steer-pairing';

/**
 * Which answer a steer belongs to.
 *
 * The chip has to sit above the answer it shaped, and on the MVP wire the steer and
 * the answer travel separately — the steer goes up as a `transcript.input` and the
 * answer comes back as an unrelated `suggestion.start`. So the pairing is FIFO, and
 * the cases that can go wrong are all about identity: a card must never take a steer
 * twice, a re-render must never consume a second one, and a discarded card must not
 * hand its steer on to whatever arrives next.
 */

describe('steer pairing', () => {
  it('holds a steer that has no answer yet', () => {
    const pairing = steerSubmitted(emptySteerPairing, 'push on the timeline');

    expect(pairing.pending).toEqual(['push on the timeline']);
    expect(pairing.byId).toEqual({});
  });

  it('gives the pending steer to the next answer that starts', () => {
    const submitted = steerSubmitted(emptySteerPairing, 'push on the timeline');

    const paired = pairSteerArrivals(submitted, ['s1']);

    expect(paired.byId).toEqual({ s1: 'push on the timeline' });
    expect(paired.pending).toEqual([]);
  });

  it('leaves an unsteered answer unsteered', () => {
    const paired = pairSteerArrivals(emptySteerPairing, ['s1']);

    expect(paired.byId).toEqual({});
  });

  it('pairs two steers with two answers, in the order they were sent', () => {
    let pairing = steerSubmitted(emptySteerPairing, 'first');
    pairing = steerSubmitted(pairing, 'second');

    pairing = pairSteerArrivals(pairing, ['s1']);
    pairing = pairSteerArrivals(pairing, ['s1', 's2']);

    expect(pairing.byId).toEqual({ s1: 'first', s2: 'second' });
    expect(pairing.pending).toEqual([]);
  });

  it('never re-pairs an answer it has already seen', () => {
    // The screen calls this on EVERY render — a second pass over the same list
    // must not eat the steer waiting for the next card.
    let pairing = steerSubmitted(emptySteerPairing, 'first');
    pairing = pairSteerArrivals(pairing, ['s1']);
    pairing = steerSubmitted(pairing, 'second');

    const again = pairSteerArrivals(pairing, ['s1']);

    expect(again.byId).toEqual({ s1: 'first' });
    expect(again.pending).toEqual(['second']);
  });

  it('returns the same object when nothing changed', () => {
    // The screen adjusts state DURING render off this result, so an identical
    // pairing has to compare identical or the render loops forever.
    const paired = pairSteerArrivals(emptySteerPairing, ['s1']);

    expect(pairSteerArrivals(paired, ['s1'])).toBe(paired);
  });

  it('does not hand a discarded answer’s steer to the next one', () => {
    // `suggestion.discard` removes the entry from the list. The steer went with
    // that card; the answer that arrives next was not shaped by it.
    let pairing = steerSubmitted(emptySteerPairing, 'first');
    pairing = pairSteerArrivals(pairing, ['s1']);
    pairing = pairSteerArrivals(pairing, []);
    pairing = pairSteerArrivals(pairing, ['s2']);

    expect(pairing.byId.s2).toBeUndefined();
  });

  it('starts empty again for a new call', () => {
    let pairing = steerSubmitted(emptySteerPairing, 'first');
    pairing = pairSteerArrivals(pairing, ['s1']);

    expect(emptySteerPairing.pending).toEqual([]);
    expect(emptySteerPairing.byId).toEqual({});
    expect(pairing).not.toBe(emptySteerPairing);
  });
});
