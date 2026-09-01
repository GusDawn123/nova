/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeetingListItem } from "@nova/shared";

import { HistoryPanel } from "./history-panel";

function meeting(overrides: Partial<MeetingListItem>): MeetingListItem {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    title: "Weekend crew scheduling call",
    started_at: "2026-08-14T19:00:00.000Z",
    ended_at: "2026-08-14T23:08:00.000Z",
    notes_status: "completed",
    tldr: null,
    conversation_type: null,
    action_item_count: 2,
    has_follow_up: false,
    ...overrides,
  };
}

function installBridge(listMeetings: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, "novaBridge", {
    value: { listMeetings },
    configurable: true,
  });
}

afterEach(cleanup);

describe("HistoryPanel", () => {
  it("renders the real sessions with their duration and opens one on click", async () => {
    installBridge(
      vi.fn().mockResolvedValue({
        ok: true,
        data: { meetings: [meeting({})], month_count: 1 },
      }),
    );
    const onOpenMeeting = vi.fn();
    render(<HistoryPanel onBack={() => {}} onOpenMeeting={onOpenMeeting} />);

    const row = await screen.findByText("Weekend crew scheduling call");
    expect(screen.getByText("4h 8m")).toBeTruthy();

    fireEvent.click(row);
    expect(onOpenMeeting).toHaveBeenCalledWith(
      "55555555-5555-4555-8555-555555555555",
      "Weekend crew scheduling call",
    );
  });

  it("a failure arrives as main's sentence plus a way to try again", async () => {
    const listMeetings = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        kind: "network",
        message: "Could not reach Nova (offline).",
      })
      .mockResolvedValue({ ok: true, data: { meetings: [], month_count: 0 } });
    installBridge(listMeetings);
    render(<HistoryPanel onBack={() => {}} onOpenMeeting={() => {}} />);

    expect(
      await screen.findByText("Could not reach Nova (offline)."),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Try again"));

    expect(await screen.findByText(/No sessions yet/)).toBeTruthy();
    expect(listMeetings).toHaveBeenCalledTimes(2);
  });
});
