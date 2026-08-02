import { describe, expect, it } from 'vitest';
import type { MeetingListItem, NotesStatus } from '@nova/shared';

import {
  formatDuration,
  formatRelativeDay,
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
    ['failed', 'Notes failed'],
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

  it('states the failure rather than commanding a retry', () => {
    // These words are now SPOKEN — they land inside the card's accessibility
    // label and in the detail screen's meta line, where "retry notes" is heard
    // as a control the user is being told to operate rather than as the status
    // of the call they are looking at.
    expect(statusToPill('failed').tone).toBe('hot');
    expect(statusToPill('failed').label).not.toMatch(/retry/i);
  });
});

describe('formatRelativeDay', () => {
  const now = new Date(2026, 6, 22, 15, 0);

  it('names today as today', () => {
    expect(formatRelativeDay(new Date(2026, 6, 22, 9).toISOString(), now)).toBe(
      'Today',
    );
  });

  it('names a day inside the last week by its weekday', () => {
    // 'en-US' pinned: the runner's default locale is not the user's, and an
    // unpinned assertion would pass or fail on the machine rather than the code.
    expect(
      formatRelativeDay(new Date(2026, 6, 20, 9).toISOString(), now, 'en-US'),
    ).toBe('Mon');
  });

  it('falls back to a date for anything older', () => {
    expect(
      formatRelativeDay(new Date(2026, 5, 2, 9).toISOString(), now, 'en-US'),
    ).toBe('Jun 2');
  });

  it('holds the weekday to the sixth day back, and no further', () => {
    // The rolling window's two edges. Without this pair its WIDTH is unconstrained
    // and an off-by-one — or a DST-shifted boundary — is invisible.
    expect(
      formatRelativeDay(new Date(2026, 6, 16, 9).toISOString(), now, 'en-US'),
    ).toBe('Thu');
    expect(
      formatRelativeDay(new Date(2026, 6, 15, 9).toISOString(), now, 'en-US'),
    ).toBe('Jul 15');
  });

  it('counts the window in calendar days, not in 24-hour blocks', () => {
    // A day is not always 86,400 seconds long. Subtracting six of them lands an
    // hour either side of local midnight across a DST change, which files a call in
    // that hour under the wrong heading. Counted on the calendar, the boundary is
    // midnight on the sixth day back wherever this runs and whenever it runs.
    const edge = new Date(2026, 6, 16, 0, 0, 0);
    expect(formatRelativeDay(edge.toISOString(), now, 'en-US')).toBe('Thu');
    expect(
      formatRelativeDay(
        new Date(2026, 6, 15, 23, 59, 59).toISOString(),
        now,
        'en-US',
      ),
    ).toBe('Jul 15');
  });

  it('has nothing to say about a missing or unparseable moment', () => {
    expect(formatRelativeDay(null, now)).toBeNull();
    expect(formatRelativeDay('not a date', now)).toBeNull();
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

  it('never prints "60 sec" at the minute boundary', () => {
    // Rounding up here would name a duration the minute branch declined to take.
    expect(
      formatDuration('2026-07-22T10:00:00.000Z', '2026-07-22T10:00:59.600Z'),
    ).toBe('59 sec');
    expect(
      formatDuration('2026-07-22T10:00:00.000Z', '2026-07-22T10:01:00.000Z'),
    ).toBe('1 min');
  });

  it('returns null for a call that lasted no time at all', () => {
    // Same instant at both ends: say nothing rather than "0 sec".
    expect(
      formatDuration('2026-07-22T12:40:00.000Z', '2026-07-22T12:40:00.000Z'),
    ).toBeNull();
    expect(
      formatDuration('2026-07-22T12:40:00.000Z', '2026-07-22T12:40:00.400Z'),
    ).toBeNull();
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

  it('runs the week to the sixth day back and stops there', () => {
    // Same two edges the relative-day ladder is pinned on, so the section a call was
    // tapped from and the day printed on the detail screen cannot disagree.
    const sections = groupMeetingsByRecency(
      [
        item({ id: 'inside', started_at: localIso(2026, 6, 16, 0) }),
        item({ id: 'outside', started_at: localIso(2026, 6, 15, 23) }),
      ],
      now,
    );

    expect(sections.find((s) => s.group === 'this week')?.meetings[0]?.id).toBe(
      'inside',
    );
    expect(sections.find((s) => s.group === 'earlier')?.meetings[0]?.id).toBe(
      'outside',
    );
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
