import { describe, expect, it } from 'vitest';
import type { MeetingTranscriptTurn } from '@nova/shared';

import {
  formatCallClock,
  groupTranscriptBySpeaker,
  speakerTag,
} from './transcript';

/**
 * Transcript tab presentation logic (§7.6). Pure, so the real edge cases live here:
 * the nullable vendor fields and the question of when two turns are ONE person
 * speaking.
 */

function turn(
  overrides: Partial<MeetingTranscriptTurn> = {},
): MeetingTranscriptTurn {
  return { speaker: 'dana', ts_ms: 4000, content: 'hello', ...overrides };
}

describe('formatCallClock', () => {
  it('renders a call-relative offset as mm:ss', () => {
    expect(formatCallClock(4000)).toBe('00:04');
  });

  it('pads both fields so timestamps stay column-aligned', () => {
    expect(formatCallClock(65_000)).toBe('01:05');
  });

  it('keeps counting minutes past an hour instead of wrapping to zero', () => {
    // A 90-minute call is normal and 30:00 would be a lie about when this was said.
    expect(formatCallClock(90 * 60 * 1000)).toBe('90:00');
  });

  it('returns null when the vendor gave no offset', () => {
    expect(formatCallClock(null)).toBeNull();
  });
});

describe('groupTranscriptBySpeaker', () => {
  it('merges consecutive turns from the same speaker into one block', () => {
    const blocks = groupTranscriptBySpeaker([
      turn({ content: 'so about pricing', ts_ms: 4000 }),
      turn({ content: 'we landed at 47,500', ts_ms: 9000 }),
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.lines).toEqual(['so about pricing', 'we landed at 47,500']);
  });

  it('starts a new block when the speaker changes', () => {
    const blocks = groupTranscriptBySpeaker([
      turn({ speaker: 'dana' }),
      turn({ speaker: 'sam' }),
      turn({ speaker: 'dana' }),
    ]);

    expect(blocks.map((b) => b.speaker)).toEqual(['dana', 'sam', 'dana']);
  });

  it('never merges consecutive unlabelled turns', () => {
    // Merging two nulls would assert "the same person said both", which the
    // diarizer never claimed. Two blocks is the honest rendering.
    const blocks = groupTranscriptBySpeaker([
      turn({ speaker: null, content: 'first' }),
      turn({ speaker: null, content: 'second' }),
    ]);

    expect(blocks).toHaveLength(2);
  });

  it("stamps a block with its first turn's offset", () => {
    const blocks = groupTranscriptBySpeaker([
      turn({ ts_ms: 4000 }),
      turn({ ts_ms: 9000 }),
    ]);

    expect(blocks[0]?.tsMs).toBe(4000);
  });

  it('carries a null offset rather than inventing one from a later turn', () => {
    const blocks = groupTranscriptBySpeaker([
      turn({ ts_ms: null }),
      turn({ ts_ms: 9000 }),
    ]);

    expect(blocks[0]?.tsMs).toBeNull();
  });

  it('returns no blocks for an empty transcript', () => {
    expect(groupTranscriptBySpeaker([])).toEqual([]);
  });
});

describe('speakerTag', () => {
  it('reads the live convention: `me` is the user, `them` is the other side', () => {
    expect(speakerTag('me')).toBe('ME');
    expect(speakerTag('Me')).toBe('ME');
    expect(speakerTag('them')).toBe('THEM');
  });

  it('shows a diarized label as GIVEN rather than guessing who it is', () => {
    // The vendor's `spk_0` names a voice, not a person. Calling it THEM would
    // claim the user is not that speaker, which the diarizer never said.
    expect(speakerTag('spk_0')).toBe('SPK_0');
  });

  it('has no tag for an unlabelled turn', () => {
    expect(speakerTag(null)).toBeNull();
  });
});
