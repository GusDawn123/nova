/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotesReadResponse } from "@nova/shared";

import { NotesView } from "./notes-view";

/** The completed read every happy-path test unfolds. */
function completedRead(): NotesReadResponse {
  return {
    notes_status: "completed",
    notes: {
      version: 2,
      conversationType: "sales",
      title: "Pricing call with Acme",
      tldr: "Acme wants the annual plan if onboarding is included.",
      overview: "A short call about pricing and onboarding.",
      decisions: [
        { id: "d1", text: "Offer the annual plan", quote: null },
      ],
      actionItems: [],
      openQuestions: [],
      risks: [],
      typeInsights: { type: "sales", items: [] },
      source: "generated",
    },
    follow_up: null,
    notes_generated_at: "2026-08-14T20:15:00.000Z",
    live_notes: null,
    live_notes_rev: null,
    completed_item_ids: [],
  } as unknown as NotesReadResponse;
}

interface BridgeStubs {
  meetingNotes: ReturnType<typeof vi.fn>;
  meetingTranscript: ReturnType<typeof vi.fn>;
  regenerateNotes: ReturnType<typeof vi.fn>;
  followUpDraft: ReturnType<typeof vi.fn>;
}

function installBridge(overrides: Partial<BridgeStubs> = {}): BridgeStubs {
  const stubs: BridgeStubs = {
    meetingNotes: vi
      .fn()
      .mockResolvedValue({ ok: true, data: completedRead() }),
    meetingTranscript: vi.fn().mockResolvedValue({
      ok: true,
      data: {
        turns: [{ speaker: "them", ts_ms: 63_000, content: "Sounds good." }],
      },
    }),
    regenerateNotes: vi
      .fn()
      .mockResolvedValue({ ok: true, data: { status: "queued" } }),
    followUpDraft: vi.fn().mockResolvedValue({
      ok: true,
      data: { tone: "warm", subject: "Thanks!", body: "Great talking." },
    }),
    ...overrides,
  };
  Object.defineProperty(window, "novaBridge", {
    value: stubs,
    configurable: true,
  });
  return stubs;
}

const MEETING_ID = "44444444-4444-4444-8444-444444444444";

function view(): ReturnType<typeof render> {
  return render(
    <NotesView meetingId={MEETING_ID} title="Pricing call" onBack={() => {}} />,
  );
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(cleanup);

describe("the notes tab", () => {
  it("unfolds a completed read: tldr, overview, and the sections that exist", async () => {
    installBridge();
    view();

    expect(
      await screen.findByText(/annual plan if onboarding/),
    ).toBeTruthy();
    expect(screen.getByText("DECISIONS")).toBeTruthy();
    // empty sections never render their headers — absence is not content
    expect(screen.queryByText("RISKS")).toBeNull();
  });

  it("a failed generation says so in words and offers to generate", async () => {
    const stubs = installBridge({
      meetingNotes: vi.fn().mockResolvedValue({
        ok: true,
        data: { ...completedRead(), notes_status: "failed", notes: null },
      }),
    });
    view();

    fireEvent.click(await screen.findByText("Generate notes"));
    await waitFor(() => {
      expect(stubs.regenerateNotes).toHaveBeenCalledWith(MEETING_ID);
    });
  });

  it("a queued read shows GENERATING and re-reads on the poll", async () => {
    const reads = [
      { ok: true, data: { ...completedRead(), notes_status: "queued", notes: null } },
      { ok: true, data: completedRead() },
    ];
    const meetingNotes = vi
      .fn()
      .mockImplementation(() => Promise.resolve(reads[Math.min(meetingNotes.mock.calls.length - 1, 1)]));
    installBridge({ meetingNotes });
    view();

    expect(await screen.findByText("GENERATING")).toBeTruthy();
    // the second read lands on the poll's cadence and replaces the state
    await waitFor(
      () => {
        expect(screen.queryByText("GENERATING")).toBeNull();
      },
      { timeout: 7000 },
    );
  }, 10_000);
});

describe("the transcript tab", () => {
  it("loads lazily on first open and renders the turns", async () => {
    const stubs = installBridge();
    view();
    await screen.findByText("DECISIONS");

    expect(stubs.meetingTranscript).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("TRANSCRIPT"));

    expect(await screen.findByText("Sounds good.")).toBeTruthy();
    expect(screen.getByText("01:03")).toBeTruthy();
    expect(stubs.meetingTranscript).toHaveBeenCalledWith(MEETING_ID);
  });
});

describe("the follow-up tab", () => {
  it("drafts in the picked tone and renders the draft", async () => {
    const stubs = installBridge();
    view();
    await screen.findByText("DECISIONS");

    fireEvent.click(screen.getByText("FOLLOW-UP"));
    fireEvent.click(screen.getByText("WARM"));
    fireEvent.click(screen.getByText("Draft follow-up"));

    expect(await screen.findByText("Thanks!")).toBeTruthy();
    expect(stubs.followUpDraft).toHaveBeenCalledWith(MEETING_ID, "warm");
  });
});
