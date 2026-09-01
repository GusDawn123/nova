import { describe, expect, it } from "vitest";
import type { MeetingListItem } from "@nova/shared";

import { groupByDay, meetingDuration, meetingTime } from "./meeting-format";

function item(overrides: Partial<MeetingListItem>): MeetingListItem {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    title: "Weekly sync",
    started_at: "2026-08-14T19:00:00.000Z",
    ended_at: "2026-08-14T20:12:00.000Z",
    notes_status: "completed",
    tldr: null,
    conversation_type: null,
    action_item_count: 0,
    has_follow_up: false,
    ...overrides,
  };
}

describe("meetingDuration", () => {
  it("reads hours and minutes off the two timestamps", () => {
    expect(meetingDuration(item({}))).toBe("1h 12m");
  });

  it("a call still live has no duration to claim", () => {
    expect(meetingDuration(item({ ended_at: null }))).toBeNull();
  });

  it("under a minute is under a minute, not zero", () => {
    expect(
      meetingDuration(
        item({ ended_at: "2026-08-14T19:00:30.000Z" }),
      ),
    ).toBe("<1m");
  });
});

describe("meetingTime", () => {
  it("a meeting that never connected shows a dash, not a fake time", () => {
    expect(meetingTime(item({ started_at: null }))).toBe("—");
  });
});

describe("groupByDay", () => {
  it("adjacent same-day meetings share one label; a new day opens a group", () => {
    const groups = groupByDay([
      item({ id: "a".repeat(8) }),
      item({ id: "b".repeat(8) }),
      item({ id: "c".repeat(8), started_at: "2026-08-13T15:00:00.000Z" }),
    ]);

    expect(groups.map((group) => group.items.length)).toEqual([2, 1]);
    expect(groups[0]?.label).not.toBe(groups[1]?.label);
    expect(groups[0]?.label).toMatch(/2026$/);
  });
});
