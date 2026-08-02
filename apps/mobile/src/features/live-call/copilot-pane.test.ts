import { describe, expect, it, vi } from 'vitest';

import type { LiveSuggestion } from '@/hooks/use-live-session';

import { copilotEntries } from './copilot-pane';
import {
  emptySteerPairing,
  pairSteerArrivals,
  steerSubmitted,
} from './steer-pairing';

/**
 * The history's card list, and the one property that is not obvious from reading it:
 * a steered card KEEPS ITS IDENTITY when the server finally names its answer.
 *
 * The card is drawn the instant RESPOND is pressed, holding the thinking indicator.
 * `suggestion.start` arrives a second or so later. If the key changed at that moment
 * React would unmount and remount the card — the cycling word would snap back to its
 * first beat and the bar sweeps would restart, mid-wait, for no reason the user can
 * see. So the key comes from the STEER, which existed first.
 *
 * Only the pure list builder is exercised here, but importing it reaches the card and
 * from there Reanimated, which cannot resolve under vitest — hence the stub.
 */

vi.mock('react-native-reanimated', async () => {
  const { reanimatedStub } = await import('@/testing/reanimated-stub');
  return reanimatedStub();
});

function suggestion(
  id: string,
  overrides: Partial<LiveSuggestion> = {},
): LiveSuggestion {
  return { id, kind: 'answer', text: '', streaming: true, ...overrides };
}

describe('copilotEntries', () => {
  it('draws a card for a steer whose answer has not started', () => {
    const pairing = steerSubmitted(emptySteerPairing, 'push on the timeline');

    const entries = copilotEntries([], pairing);

    expect(entries).toHaveLength(1);
    expect(entries[0].steer).toBe('push on the timeline');
    expect(entries[0].text).toBe('');
    expect(entries[0].streaming).toBe(true);
  });

  it('keeps the same key when the answer to that steer starts', () => {
    const submitted = steerSubmitted(emptySteerPairing, 'push on the timeline');
    const waiting = copilotEntries([], submitted);

    const paired = pairSteerArrivals(submitted, ['s1']);
    const started = copilotEntries([suggestion('s1')], paired);

    expect(started).toHaveLength(1);
    expect(started[0].key).toBe(waiting[0].key);
    expect(started[0].steer).toBe('push on the timeline');
  });

  it('keys an unsteered answer by its own id', () => {
    const paired = pairSteerArrivals(emptySteerPairing, ['s1']);

    const entries = copilotEntries([suggestion('s1')], paired);

    expect(entries[0].key).toBe('s1');
    expect(entries[0].steer).toBeNull();
  });

  it('keeps two waiting steers in the order they were sent, with stable keys', () => {
    let pairing = steerSubmitted(emptySteerPairing, 'first');
    pairing = steerSubmitted(pairing, 'second');
    const waiting = copilotEntries([], pairing);

    pairing = pairSteerArrivals(pairing, ['s1']);
    const afterFirst = copilotEntries([suggestion('s1')], pairing);

    expect(waiting.map((entry) => entry.steer)).toEqual(['first', 'second']);
    // The first card kept its identity; the second is still waiting under its own.
    expect(afterFirst[0].key).toBe(waiting[0].key);
    expect(afterFirst[1].key).toBe(waiting[1].key);
    expect(afterFirst[1].steer).toBe('second');
  });
});
