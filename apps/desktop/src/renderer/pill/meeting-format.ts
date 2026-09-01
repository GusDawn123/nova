import type { MeetingListItem } from "@nova/shared";

/**
 * The history rows' three readable facts — when, how long, which day — derived
 * from the wire timestamps. Pure and clock-free: `now` never enters, so a row
 * renders the same in a test as it did in the call.
 *
 * Mobile's `features/meetings/format.ts` answers richer questions (relative
 * days, list filters); these are only the three the pill's rows print, kept
 * local because apps do not import each other's source.
 */

/** `3:04 PM` — the row's right edge; an em dash when the call never started. */
export function meetingTime(item: MeetingListItem): string {
  if (item.started_at === null) {
    return "—";
  }
  return new Date(item.started_at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** `1h 12m` / `8m` / `<1m` — null when either end of the call is unknown. */
export function meetingDuration(item: MeetingListItem): string | null {
  if (item.started_at === null || item.ended_at === null) {
    return null;
  }
  const ms = Date.parse(item.ended_at) - Date.parse(item.started_at);
  if (!Number.isFinite(ms) || ms < 0) {
    return null;
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return "<1m";
  }
  const hours = Math.floor(minutes / 60);
  return hours > 0
    ? `${String(hours)}h ${String(minutes % 60)}m`
    : `${String(minutes)}m`;
}

/** `FRI, AUG 14, 2026` — the dated group label, in the mockup's own casing. */
export function meetingDayLabel(item: MeetingListItem): string {
  if (item.started_at === null) {
    return "UNDATED";
  }
  return new Date(item.started_at)
    .toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    })
    .toUpperCase();
}

/** The list grouped by day label, newest group first, list order preserved. */
export function groupByDay(
  meetings: readonly MeetingListItem[],
): { label: string; items: MeetingListItem[] }[] {
  const groups: { label: string; items: MeetingListItem[] }[] = [];
  for (const item of meetings) {
    const label = meetingDayLabel(item);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.label === label) {
      last.items.push(item);
    } else {
      groups.push({ label, items: [item] });
    }
  }
  return groups;
}
