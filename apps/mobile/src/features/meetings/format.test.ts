import { describe, expect, it } from 'vitest';
import type { MeetingListItem, NotesStatus } from '@nova/shared';

import {
  cardChips,
  formatDuration,
  formatStartTime,
  groupMeetingsByRecency,
  statusToPill,
} from './format';

/**
 * Meetings list presentation logic (§7.6). Pure, so this is where the list's real
 * edge cases live: nullable timestamps, the local-midnight boundary, and the pill
 * mapping.
 */

function item(overrides: Partial<MeetingListItem> = {}): MeetingListItem {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Northwind discovery',
    started_at: '2026-07-22T12:40:00.000Z',
    ended_at: '2026-07-22T13:14:00.000Z',
    notes_status: 'completed',
    tldr: 'Three vendors, $40k left.',
    conversation_type: 'sales',
    action_item_count: 3,
    has_follow_up: true,
    ...overrides,
  };
}

describe('statusToPill', () => {
  const cases: [NotesStatus, string][] = [
    ['completed', 'Notes ready'],
    ['processing', 'Writing notes'],
    ['queued', 'Queued'],
    ['failed', 'Retry notes'],
    ['none', 'No notes'],
  ];

  it.each(cases)('maps %s', (status, label) => {
    expect(statusToPill(status).label).toBe(label);
  });

  it('shimmers only while work is actually in flight', () => {
    expect(statusToPill('processing').tone).toBe('shimmer');
    expect(statusToPill('queued').tone).toBe('shimmer');
    expect(statusToPill('completed').tone).toBe('accent');
    expect(statusToPill('none').tone).toBe('muted');
  });

  it('presents a failure as a retry action, not a dead end', () => {
    expect(statusToPill('failed').tone).toBe('hot');
    expect(statusToPill('failed').label).toMatch(/retry/i);
  });
});

describe('formatDuration', () => {
  it('formats minutes', () => {
    expect(
      formatDuration('2026-07-22T12:40:00Z', '2026-07-22T13:14:00Z'),
    ).toBe('34 min');
  });

  it('formats hours, with and without a remainder', () => {
    expect(formatDuration('2026-07-22T10:00:00Z', '2026-07-22T11:12:00Z')).toBe(
      '1 hr 12 min',
    );
    expect(formatDuration('2026-07-22T10:00:00Z', '2026-07-22T12:00:00Z')).toBe(
      '2 hr',
    );
  });

  it('falls to seconds for a sub-minute call', () => {
    expect(formatDuration('2026-07-22T10:00:00Z', '2026-07-22T10:00:48Z')).toBe(
      '48 sec',
    );
  });

  it('returns null when either end is missing', () => {
    // A live call and a never-connected meeting both land here. Printing "0 min"
    // would read as a call that happened and lasted no time.
    expect(formatDuration(null, '2026-07-22T13:14:00Z')).toBeNull();
    expect(formatDuration('2026-07-22T12:40:00Z', null)).toBeNull();
    expect(formatDuration(null, null)).toBeNull();
  });

  it('returns null for a negative or unparseable span', () => {
    expect(formatDuration('2026-07-22T13:00:00Z', '2026-07-22T12:00:00Z')).toBeNull();
    expect(formatDuration('not a date', '2026-07-22T12:00:00Z')).toBeNull();
  });
});

describe('formatStartTime', () => {
  it('returns null for null and for garbage', () => {
    expect(formatStartTime(null)).toBeNull();
    expect(formatStartTime('not a date')).toBeNull();
  });

  it('produces a clock time', () => {
    expect(formatStartTime('2026-07-22T12:40:00Z', 'en-US')).toMatch(
      /\d{1,2}:\d{2}/,
    );
  });
});

describe('groupMeetingsByRecency', () => {
  // Local noon, so the local-midnight boundaries are unambiguous wherever this runs.
  const now = new Date(2026, 6, 22, 12, 0, 0);
  const localIso = (y: number, m: number, d: number, h = 12): string =>
    new Date(y, m, d, h).toISOString();

  it('splits today / this week / earlier', () => {
    const sections = groupMeetingsByRecency(
      [
        item({ id: 'a', started_at: localIso(2026, 6, 22) }),
        item({ id: 'b', started_at: localIso(2026, 6, 20) }),
        item({ id: 'c', started_at: localIso(2026, 5, 30) }),
      ],
      now,
    );

    expect(sections.map((s) => s.group)).toEqual([
      'today',
      'this week',
      'earlier',
    ]);
    expect(sections[0]?.meetings.map((m) => m.id)).toEqual(['a']);
    expect(sections[2]?.meetings.map((m) => m.id)).toEqual(['c']);
  });

  it('uses LOCAL midnight, not a rolling 24 hours', () => {
    // 11pm last night is 13 hours ago but it is not today. Grouping on elapsed time
    // would put it under "today" and read as wrong to anyone looking at a calendar.
    const lastNight = localIso(2026, 6, 21, 23);
    const sections = groupMeetingsByRecency(
      [item({ id: 'late', started_at: lastNight })],
      now,
    );

    expect(sections[0]?.group).toBe('this week');
  });

  it('keeps a call from earlier today in today, however early', () => {
    const sections = groupMeetingsByRecency(
      [item({ id: 'dawn', started_at: localIso(2026, 6, 22, 0) })],
      now,
    );
    expect(sections[0]?.group).toBe('today');
  });

  it('drops empty sections rather than rendering bare headings', () => {
    const sections = groupMeetingsByRecency(
      [item({ id: 'a', started_at: localIso(2026, 6, 22) })],
      now,
    );
    expect(sections).toHaveLength(1);
  });

  it('puts undatable meetings in earlier', () => {
    const sections = groupMeetingsByRecency(
      [
        item({ id: 'never', started_at: null }),
        item({ id: 'today', started_at: localIso(2026, 6, 22) }),
      ],
      now,
    );

    expect(sections.find((s) => s.group === 'earlier')?.meetings[0]?.id).toBe(
      'never',
    );
  });

  it('preserves the server order within a section', () => {
    const sections = groupMeetingsByRecency(
      [
        item({ id: 'first', started_at: localIso(2026, 6, 22, 14) }),
        item({ id: 'second', started_at: localIso(2026, 6, 22, 9) }),
      ],
      now,
    );

    expect(sections[0]?.meetings.map((m) => m.id)).toEqual(['first', 'second']);
  });

  it('returns nothing for an empty list', () => {
    expect(groupMeetingsByRecency([], now)).toEqual([]);
  });
});

describe('cardChips', () => {
  it('builds type, count and follow-up chips', () => {
    expect(cardChips(item())).toEqual([
      'sales',
      '3 action items',
      'follow-up drafted',
    ]);
  });

  it('singularises one action item', () => {
    expect(cardChips(item({ action_item_count: 1 }))).toContain('1 action item');
  });

  it('omits every chip it has no data for', () => {
    expect(
      cardChips(
        item({
          conversation_type: null,
          action_item_count: 0,
          has_follow_up: false,
        }),
      ),
    ).toEqual([]);
  });
});
