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

    expect(pairing.pending.map((steer) => steer.text)).toEqual([
      'push on the timeline',
    ]);
    expect(pairing.byId.size).toBe(0);
  });

  it('gives the pending steer to the next answer that starts', () => {
    const submitted = steerSubmitted(emptySteerPairing, 'push on the timeline');

    const paired = pairSteerArrivals(submitted, ['s1']);

    expect(paired.byId.get('s1')?.text).toBe('push on the timeline');
    expect(paired.pending).toEqual([]);
  });

  it('leaves an unsteered answer unsteered', () => {
    const paired = pairSteerArrivals(emptySteerPairing, ['s1']);

    expect(paired.byId.size).toBe(0);
  });

  it('pairs two steers with two answers, in the order they were sent', () => {
    let pairing = steerSubmitted(emptySteerPairing, 'first');
    pairing = steerSubmitted(pairing, 'second');

    pairing = pairSteerArrivals(pairing, ['s1']);
    pairing = pairSteerArrivals(pairing, ['s1', 's2']);

    expect(pairing.byId.get('s1')?.text).toBe('first');
    expect(pairing.byId.get('s2')?.text).toBe('second');
    expect(pairing.pending).toEqual([]);
  });

  it('never re-pairs an answer it has already seen', () => {
    // The screen calls this on EVERY render — a second pass over the same list
    // must not eat the steer waiting for the next card.
    let pairing = steerSubmitted(emptySteerPairing, 'first');
    pairing = pairSteerArrivals(pairing, ['s1']);
    pairing = steerSubmitted(pairing, 'second');

    const again = pairSteerArrivals(pairing, ['s1']);

    expect(again.byId.get('s1')?.text).toBe('first');
    expect(again.byId.size).toBe(1);
    expect(again.pending.map((steer) => steer.text)).toEqual(['second']);
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

    expect(pairing.byId.get('s2')).toBeUndefined();
  });

  it('gives every steer its own key, and never renumbers one', () => {
    // The key IS the card's identity — it exists before the server names the answer,
    // and it must survive that naming. Two steers sharing one would swap cards.
    let pairing = steerSubmitted(emptySteerPairing, 'first');
    pairing = steerSubmitted(pairing, 'second');
    const [first, second] = pairing.pending;

    pairing = pairSteerArrivals(pairing, ['s1']);

    expect(first.key).not.toBe(second.key);
    expect(pairing.byId.get('s1')?.key).toBe(first.key);
    expect(pairing.pending[0].key).toBe(second.key);
  });

  it('starts empty again for a new call', () => {
    let pairing = steerSubmitted(emptySteerPairing, 'first');
    pairing = pairSteerArrivals(pairing, ['s1']);

    expect(emptySteerPairing.pending).toEqual([]);
    expect(emptySteerPairing.byId.size).toBe(0);
    expect(pairing).not.toBe(emptySteerPairing);
  });
});
