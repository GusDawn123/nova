/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SuggestionCard } from "./suggestion-card";

// Auto-cleanup needs vitest globals, which this repo does not enable — without
// this, the previous test's render leaks into the next test's queries.
afterEach(cleanup);

/**
 * The card is presentation over `use-live-session`'s suggestion state (the
 * merge rules are pinned in use-live-session.test.ts); what's pinned HERE is
 * the rendering contract: streaming vs done, the two surface variants, and
 * the screen-reader status line.
 */

describe("SuggestionCard", () => {
  it("renders a streaming suggestion dimmed, with the live dot and a placeholder for empty text", () => {
    const { container } = render(
      <SuggestionCard
        suggestion={{ id: "s-1", text: "", done: false }}
        variant="floating"
      />,
    );
    expect(screen.getByText("…")).toBeTruthy();
    expect(container.querySelector(".suggestion__live-dot")).not.toBeNull();
    expect(
      container.querySelector(".suggestion__text--streaming"),
    ).not.toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Nova is suggesting");
  });

  it("renders a completed suggestion at full strength, dot gone, status flipped", () => {
    const { container } = render(
      <SuggestionCard
        suggestion={{ id: "s-1", text: "The final body.", done: true }}
        variant="floating"
      />,
    );
    expect(screen.getByText("The final body.")).toBeTruthy();
    expect(container.querySelector(".suggestion__live-dot")).toBeNull();
    expect(container.querySelector(".suggestion__text--streaming")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "Nova suggestion ready",
    );
  });

  it.each(["floating", "inset"] as const)(
    "carries the %s variant class for its surface",
    (variant) => {
      const { container } = render(
        <SuggestionCard
          suggestion={{ id: "s-1", text: "body", done: false }}
          variant={variant}
        />,
      );
      expect(container.querySelector(`.suggestion--${variant}`)).not.toBeNull();
    },
  );
});
