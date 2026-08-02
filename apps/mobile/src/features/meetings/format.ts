import type { MeetingListItem, NotesStatus } from '@nova/shared';

/**
 * Pure presentation logic for the Meetings list (Phase 8.5,
 * `docs/DESIGN/notes-ui.md` §7.6). No React, no I/O — everything here is a function
 * of its arguments so the list's real behaviour is testable without a renderer.
 */

/** How the card's status pill reads. */
export interface StatusPill {
  label: string;
  /** `accent` = ready, `shimmer` = still working, `muted` = nothing yet, `hot` = failed. */
  tone: 'accent' | 'shimmer' | 'muted' | 'hot';
}

/**
 * `notes_status` → pill. All five values are handled explicitly rather than through
 * a default, so adding a sixth is a type error here instead of a silently
 * mislabelled card.
 */
export function statusToPill(status: NotesStatus): StatusPill {
  switch (status) {
    case 'completed':
      return { label: 'Notes ready', tone: 'accent' };
    case 'processing':
      return { label: 'Writing notes', tone: 'shimmer' };
    case 'queued':
      return { label: 'Queued', tone: 'shimmer' };
    case 'failed':
      // A STATE, not an instruction. These words are spoken now — they are read
      // out inside the meeting card's accessibility label and printed in the
      // detail screen's meta line — and "retry notes" heard in that position is a
      // control the user is being told to press, not the status of their call.
      // The retry affordance is a drawn key that says TRY AGAIN next to it.
      return { label: 'Notes failed', tone: 'hot' };
    case 'none':
      return { label: 'No notes', tone: 'muted' };
  }
}

/**
 * Call duration, e.g. "34 min", "1 hr 12 min", "48 sec".
 *
 * Returns null when either end is missing — a meeting created but never connected,
 * or one still running — and equally for a span under one second. The card omits
 * the segment entirely rather than printing "0 sec", which would read as a call
 * that happened and lasted no time.
 */
export function formatDuration(
  startedAt: string | null,
  endedAt: string | null,
): string | null {
  if (startedAt === null || endedAt === null) return null;

  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;

  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) {
    // FLOOR, not round: rounding 59.6s up prints "60 sec" for a span the minute
    // branch has already declined to take.
    const seconds = Math.floor(ms / 1000);
    if (seconds < 1) return null;
    return `${String(seconds)} sec`;
  }
  if (totalMinutes < 60) return `${String(totalMinutes)} min`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0
    ? `${String(hours)} hr`
    : `${String(hours)} hr ${String(minutes)} min`;
}

/** Local wall-clock time, e.g. "12:40 PM". Null when the call never started. */
export function formatStartTime(
  startedAt: string | null,
  locale?: string,
): string | null {
  if (startedAt === null) return null;
  const date = new Date(startedAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString(locale, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Weekday for the "earlier this week" rows, e.g. "Wed". */
function formatWeekday(startedAt: string, locale?: string): string {
  return new Date(startedAt).toLocaleDateString(locale, { weekday: 'short' });
}

/**
 * How far back a moment is, in the words a person would use: "Today", then the
 * weekday for the rest of the week, then a date.
 *
 * The ladder matters more than the format. Inside a week a weekday is the fastest
 * thing to place ("Mon" needs no arithmetic); past that a weekday is ambiguous
 * — WHICH Monday — so it becomes a date. The boundaries are LOCAL midnight and the
 * same rolling seven days {@link groupMeetingsByRecency} uses, so the detail screen
 * and the list section a call was tapped from cannot disagree about what "today" is.
 */
export function formatRelativeDay(
  isoTime: string | null,
  now: Date,
  locale?: string,
): string | null {
  if (isoTime === null) return null;
  const date = new Date(isoTime);
  if (Number.isNaN(date.getTime())) return null;

  const day = startOfLocalDay(date);
  const today = startOfLocalDay(now);
  if (day === today) return 'Today';

  const weekStart = today - 6 * 24 * 60 * 60 * 1000;
  if (day >= weekStart && day < today) return formatWeekday(isoTime, locale);

  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

/** The mock's section headings. */
export type RecencyGroup = 'today' | 'this week' | 'earlier';

export interface MeetingSection {
  group: RecencyGroup;
  meetings: MeetingListItem[];
}

/** Midnight LOCAL time on the day `date` falls in. */
function startOfLocalDay(date: Date): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

/**
 * Group meetings into the mock's sections, preserving the server's order inside
 * each and dropping empty sections.
 *
 * Boundaries are LOCAL midnight, not 24-hour windows: a call at 11pm last night is
 * "this week", not "today", however few hours ago it was. The user's sense of "today"
 * is the calendar day they are standing in.
 *
 * A meeting with no `started_at` sorts into `earlier` — it is undatable, and the
 * server already sorts those last, so it lands at the bottom where it belongs
 * rather than inventing a date for it.
 */
export function groupMeetingsByRecency(
  meetings: readonly MeetingListItem[],
  now: Date,
): MeetingSection[] {
  const todayStart = startOfLocalDay(now);
  // Seven days back, so "this week" is a rolling week rather than one that empties
  // out every Monday morning.
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;

  const buckets: Record<RecencyGroup, MeetingListItem[]> = {
    today: [],
    'this week': [],
    earlier: [],
  };

  for (const meeting of meetings) {
    if (meeting.started_at === null) {
      buckets.earlier.push(meeting);
      continue;
    }
    const started = Date.parse(meeting.started_at);
    if (Number.isNaN(started)) {
      buckets.earlier.push(meeting);
      continue;
    }
    const day = startOfLocalDay(new Date(started));
    if (day >= todayStart) buckets.today.push(meeting);
    else if (day >= weekStart) buckets['this week'].push(meeting);
    else buckets.earlier.push(meeting);
  }

  const order: RecencyGroup[] = ['today', 'this week', 'earlier'];
  return order
    .filter((group) => buckets[group].length > 0)
    .map((group) => ({ group, meetings: buckets[group] }));
}
