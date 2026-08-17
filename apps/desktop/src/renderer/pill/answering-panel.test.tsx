/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AnsweringPanel } from "./answering-panel";
import type { LiveSessionView } from "./use-live-session";

// jsdom implements neither element scrolling nor matchMedia; the panel's
// follow-the-stream effect calls both on mount.
beforeAll(() => {
  Element.prototype.scrollTo = () => undefined;
  Element.prototype.scrollBy = () => undefined;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
});

/**
 * The answering panel is the pill's mockup state 3a made real. Pinned here:
 * the question bubble, the heard-at caption, streaming vs done text, the
 * screen-reader status line, and the New Chat / Back controls. The merge
 * rules feeding `live.suggestion` live in use-live-session.test.ts.
 */

// Auto-cleanup needs vitest globals, which this repo does not enable.
afterEach(cleanup);

function liveWith(suggestion: LiveSessionView["suggestion"]): LiveSessionView {
  return { state: "live", message: null, rows: [], suggestion };
}

function renderPanel(overrides?: {
  suggestion?: LiveSessionView["suggestion"];
  question?: string | null;
  heardLabel?: string | null;
  onNewChat?: () => void;
  onBack?: () => void;
}) {
  return render(
    <AnsweringPanel
      live={liveWith(overrides?.suggestion ?? null)}
      ask={{
        question: overrides?.question ?? null,
        heardLabel: overrides?.heardLabel ?? null,
      }}
      usesScreen={false}
      onToggleScreen={() => undefined}
      undetectable={false}
      onToggleUndetectable={() => undefined}
      onOpenModes={() => undefined}
      onOpenTranscript={() => undefined}
      onNewChat={overrides?.onNewChat ?? (() => undefined)}
      onBack={overrides?.onBack ?? (() => undefined)}
    />,
  );
}

describe("AnsweringPanel", () => {
  it("shows the typed question as a bubble and the heard-at caption", () => {
    renderPanel({
      question: "How do I answer the budget pushback?",
      heardLabel: "14:22",
      suggestion: { id: "s-1", text: "Anchor on the 3 sites.", done: true },
    });
    expect(
      screen.getByText("How do I answer the budget pushback?"),
    ).toBeTruthy();
    expect(screen.getByText("Heard on call · 14:22")).toBeTruthy();
    expect(screen.getByText("Anchor on the 3 sites.")).toBeTruthy();
  });

  it("an empty-handed Answer press renders no bubble — just the answer", () => {
    const { container } = renderPanel({
      question: null,
      heardLabel: "7:31",
      suggestion: {
        id: "s-1",
        text: "Get her approved number first.",
        done: false,
      },
    });
    expect(container.querySelector(".answer__bubble")).toBeNull();
    expect(screen.getByText("Get her approved number first.")).toBeTruthy();
    expect(container.querySelector(".answer__text--streaming")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Nova is answering");
  });

  it("shows the thinking hint before the stream starts, then flips on done", () => {
    const first = renderPanel({ suggestion: null });
    expect(screen.getByText("Nova is thinking…")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Nova is thinking");
    first.unmount();

    const { container } = renderPanel({
      suggestion: { id: "s-1", text: "Done body.", done: true },
    });
    expect(container.querySelector(".answer__text--streaming")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Nova answer ready");
  });

  it("New Chat and Back fire their callbacks", () => {
    const onNewChat = vi.fn();
    const onBack = vi.fn();
    renderPanel({ onNewChat, onBack });
    fireEvent.click(screen.getByText("New Chat"));
    expect(onNewChat).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTitle("Back to pill"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
