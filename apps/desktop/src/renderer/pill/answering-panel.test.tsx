/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { AnsweringPanel, type ThreadTurn } from "./answering-panel";
import type { LiveSessionView } from "./use-live-session";

/**
 * The answering panel is the pill's mockup state 3a made real. Pinned here:
 * the question bubble, the heard-at caption, streaming vs done vs FAILED
 * states, the screen-reader status line, the scroll-follow contract, and the
 * New Chat / Back controls. The merge rules feeding `live.suggestion` live in
 * use-live-session.test.ts.
 */

// jsdom implements neither element scrolling nor matchMedia; the panel's
// follow-the-stream effect calls both on mount. Spies, not no-ops, so the
// scroll tests can assert arguments; `reducedMotion` is flippable per test.
const scrollTo = vi.fn();
const scrollBy = vi.fn();
let reducedMotion = false;

beforeAll(() => {
  Element.prototype.scrollTo = scrollTo;
  Element.prototype.scrollBy = scrollBy;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: reducedMotion,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
});

beforeEach(() => {
  scrollTo.mockClear();
  scrollBy.mockClear();
  reducedMotion = false;
});

// Auto-cleanup needs vitest globals, which this repo does not enable.
afterEach(cleanup);

function liveWith(
  suggestion: LiveSessionView["suggestion"],
  state: LiveSessionView["state"] = "live",
  message: string | null = null,
): LiveSessionView {
  return { state, message, rows: [], suggestion };
}

function renderPanel(overrides?: {
  live?: LiveSessionView;
  question?: string | null;
  heardLabel?: string | null;
  error?: string | null;
  thread?: readonly ThreadTurn[];
  onNewChat?: () => void;
  onBack?: () => void;
}) {
  return render(
    <AnsweringPanel
      live={overrides?.live ?? liveWith(null)}
      ask={{
        question: overrides?.question ?? null,
        heardLabel: overrides?.heardLabel ?? null,
        error: overrides?.error ?? null,
      }}
      thread={overrides?.thread ?? []}
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

/** Script the body's scroll metrics — jsdom's are all zero. */
function scriptScroll(
  body: Element,
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
): void {
  Object.defineProperty(body, "scrollTop", {
    configurable: true,
    writable: true,
    value: metrics.scrollTop,
  });
  Object.defineProperty(body, "scrollHeight", {
    configurable: true,
    value: metrics.scrollHeight,
  });
  Object.defineProperty(body, "clientHeight", {
    configurable: true,
    value: metrics.clientHeight,
  });
}

describe("AnsweringPanel", () => {
  it("shows the typed question as a bubble and the heard-at caption", () => {
    renderPanel({
      question: "How do I answer the budget pushback?",
      heardLabel: "14:22",
      live: liveWith({ id: "s-1", text: "Anchor on the 3 sites.", done: true }),
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
      live: liveWith({
        id: "s-1",
        text: "Get her approved number first.",
        done: false,
      }),
    });
    expect(container.querySelector(".answer__bubble")).toBeNull();
    // Streaming text carries the inline caret character at its tail.
    expect(screen.getByText(/Get her approved number first\./)).toBeTruthy();
    expect(container.querySelector(".md--streaming")).not.toBeNull();
  });

  it("a started-but-empty stream shows the placeholder, and no caption without a heard label", () => {
    // Exactly what suggestion.start produces — every single ask passes here.
    const { container } = renderPanel({
      heardLabel: null,
      live: liveWith({ id: "s-1", text: "", done: false }),
    });
    expect(screen.getByText("…")).toBeTruthy();
    expect(container.querySelector(".answer__caption")).toBeNull();
  });

  it("shows the thinking hint before the stream starts, then flips on done", () => {
    const first = renderPanel();
    expect(screen.getByText("Nova is thinking…")).toBeTruthy();
    first.unmount();

    const { container } = renderPanel({
      live: liveWith({ id: "s-1", text: "Done body.", done: true }),
    });
    expect(container.querySelector(".md--streaming")).toBeNull();
  });

  it("renders markdown as a product, not asterisks", () => {
    const { container } = renderPanel({
      live: liveWith({
        id: "s-1",
        text: "Use **exactly** the `useRef` hook:\n\n```js\nconst x = useRef(null);\n```",
        done: true,
      }),
    });
    // Bold became an element; the literal asterisks are gone from the text.
    const strong = container.querySelector(".md strong");
    expect(strong?.textContent).toBe("exactly");
    expect(container.textContent).not.toContain("**");
    // Inline syntax chip + the darker fenced block.
    expect(container.querySelector(".md code")?.textContent).toBe("useRef");
    expect(container.querySelector(".md pre code")?.textContent).toContain(
      "const x = useRef(null);",
    );
  });

  it("keeps finished Q/As above the current one — the thread", () => {
    const { container } = renderPanel({
      thread: [
        {
          question: "What did they push back on?",
          heardLabel: "3:02",
          answer: "The rollout **timeline**.",
        },
        { question: null, heardLabel: "5:40", answer: "Anchor on scope." },
      ],
      question: "And the budget?",
      live: liveWith({ id: "s-3", text: "Get her number first.", done: false }),
    });
    const turns = container.querySelectorAll(".answer__turn");
    expect(turns).toHaveLength(3); // two archived + the current
    expect(screen.getByText("What did they push back on?")).toBeTruthy();
    expect(screen.getByText("Anchor on scope.")).toBeTruthy();
    expect(screen.getByText("And the budget?")).toBeTruthy();
    // Archived markdown renders too — no asterisks in the thread.
    expect(screen.getByText("timeline")).toBeTruthy();
    expect(container.textContent).not.toContain("**");
  });

  it("a dead session with no message still explains itself", () => {
    renderPanel({ live: liveWith(null, "error", null) });
    expect(screen.getByText("The live session hit an error.")).toBeTruthy();
  });

  it("a failed ask reads as a refusal, never as thinking", () => {
    const { container } = renderPanel({
      error: "No live session is running.",
    });
    expect(screen.getByText("No live session is running.")).toBeTruthy();
    expect(container.querySelector(".answer__hint--failed")).not.toBeNull();
    expect(screen.queryByText("Nova is thinking…")).toBeNull();
  });

  it.each([
    ["error", "The live connection closed unexpectedly."],
    ["ended", "The session ended before Nova could answer."],
  ] as const)(
    "a dead session (%s) surfaces instead of thinking forever",
    (state, expected) => {
      renderPanel({
        live: liveWith(
          null,
          state,
          state === "error" ? "The live connection closed unexpectedly." : null,
        ),
      });
      expect(screen.getByText(expected)).toBeTruthy();
      expect(screen.queryByText("Nova is thinking…")).toBeNull();
    },
  );

  it("announces state changes through the live region after mount", () => {
    // The region mounts EMPTY (initial live-region content is never read) and
    // the label lands as a post-mount change, which is what announces.
    renderPanel({
      live: liveWith({ id: "s-1", text: "body", done: true }),
    });
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

  describe("the scroll-follow contract", () => {
    function bodyOf(container: HTMLElement): Element {
      const body = container.querySelector(".answer__body");
      if (body === null) throw new Error("no answer body");
      return body;
    }

    it("an upward move breaks follow and shows the jump button; the bottom restores it", () => {
      const { container } = renderPanel({
        live: liveWith({ id: "s-1", text: "long answer", done: false }),
      });
      const body = bodyOf(container);

      // Establish a baseline deep in the content, then move UP.
      scriptScroll(body, {
        scrollTop: 500,
        scrollHeight: 2000,
        clientHeight: 400,
      });
      fireEvent.scroll(body);
      scriptScroll(body, {
        scrollTop: 300,
        scrollHeight: 2000,
        clientHeight: 400,
      });
      fireEvent.scroll(body);
      expect(screen.getByTitle("Jump to latest")).toBeTruthy();

      // Back within the stick zone → following again, button gone.
      scriptScroll(body, {
        scrollTop: 1580,
        scrollHeight: 2000,
        clientHeight: 400,
      });
      fireEvent.scroll(body);
      expect(screen.queryByTitle("Jump to latest")).toBeNull();
    });

    it("the jump button scrolls to the bottom and hides itself", () => {
      const { container } = renderPanel({
        live: liveWith({ id: "s-1", text: "long answer", done: false }),
      });
      const body = bodyOf(container);
      scriptScroll(body, {
        scrollTop: 500,
        scrollHeight: 2000,
        clientHeight: 400,
      });
      fireEvent.scroll(body);
      scriptScroll(body, {
        scrollTop: 300,
        scrollHeight: 2000,
        clientHeight: 400,
      });
      fireEvent.scroll(body);

      scrollTo.mockClear();
      fireEvent.click(screen.getByTitle("Jump to latest"));
      expect(scrollTo).toHaveBeenCalledWith(
        expect.objectContaining({ top: 2000, behavior: "smooth" }),
      );
      expect(screen.queryByTitle("Jump to latest")).toBeNull();
    });

    it("Shift+Ctrl+arrows scroll the response window by the keybind step", () => {
      renderPanel({
        live: liveWith({ id: "s-1", text: "long answer", done: false }),
      });
      fireEvent.keyDown(window, {
        key: "ArrowDown",
        ctrlKey: true,
        shiftKey: true,
      });
      expect(scrollBy).toHaveBeenLastCalledWith(
        expect.objectContaining({ top: 140, behavior: "smooth" }),
      );
      fireEvent.keyDown(window, {
        key: "ArrowUp",
        ctrlKey: true,
        shiftKey: true,
      });
      expect(scrollBy).toHaveBeenLastCalledWith(
        expect.objectContaining({ top: -140, behavior: "smooth" }),
      );
    });

    it("honors prefers-reduced-motion: keyed scrolls move without animating", () => {
      reducedMotion = true;
      renderPanel({
        live: liveWith({ id: "s-1", text: "long answer", done: false }),
      });
      fireEvent.keyDown(window, {
        key: "ArrowDown",
        ctrlKey: true,
        shiftKey: true,
      });
      expect(scrollBy).toHaveBeenLastCalledWith(
        expect.objectContaining({ behavior: "auto" }),
      );
    });
  });
});
