/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AnswerMarkdown } from "./answer-markdown";

// jsdom has no clipboard; the copy control needs a spyable one.
const writeText = vi.fn(() => Promise.resolve());
beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

/**
 * The answer body's rendering contract, pinned against the output grammar the
 * authored prompts demand (M2): fenced code keeps its line structure and
 * indentation, inline code chips render, `$...$` / `$$...$$` math becomes real
 * KaTeX, and the streaming caret is CSS — never a character glued into the
 * markdown source where it can un-close a ``` fence.
 */

// Auto-cleanup needs vitest globals, which this repo does not enable.
afterEach(cleanup);

describe("AnswerMarkdown", () => {
  it("preserves indentation and line breaks inside a fenced block", () => {
    const { container } = render(
      <AnswerMarkdown
        text={
          "```python\ndef solve(nums):\n    seen = {}\n    for i, n in enumerate(nums):\n        seen[n] = i\n```"
        }
        streaming={false}
      />,
    );
    const code = container.querySelector(".md pre code");
    // The four-space indent and the newlines survive into the DOM — the
    // "one-line unindented snippet" regression this suite exists to prevent.
    expect(code?.textContent).toContain("def solve(nums):\n    seen = {}\n");
    expect(code?.textContent).toContain("\n        seen[n] = i");
  });

  it("renders inline math as KaTeX, not dollar-sign soup", () => {
    const { container } = render(
      <AnswerMarkdown
        text={"Runtime is $O(n \\log n)$ overall."}
        streaming={false}
      />,
    );
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.textContent).not.toContain("$O(");
  });

  it("renders display math blocks as KaTeX", () => {
    // The prompts' own grammar: $$...$$ on its own lines for multi-line math.
    const { container } = render(
      <AnswerMarkdown
        text={"$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$"}
        streaming={false}
      />,
    );
    expect(container.querySelector(".katex-display")).not.toBeNull();
  });

  it("keeps the streaming caret OUT of the markdown source", () => {
    // A text caret appended after a closing ``` un-closes the fence; the caret
    // is pill.css `::after` on `.md--streaming` instead, so the rendered text
    // must never contain the character itself.
    const { container } = render(
      <AnswerMarkdown text={"```js\nconst x = 1;\n```"} streaming={true} />,
    );
    expect(container.querySelector(".md--streaming")).not.toBeNull();
    expect(container.textContent).not.toContain("▍");
    // The fence still closed: the code element holds only the code.
    expect(container.querySelector(".md pre code")?.textContent).toBe(
      "const x = 1;\n",
    );
  });

  it("puts a copy control on the whole fence and copies its full text", async () => {
    const { container } = render(
      <AnswerMarkdown
        text={"```python\ndef solve():\n    return 42\n```"}
        streaming={false}
      />,
    );
    const button = screen.getByTitle("Copy code");
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledWith("def solve():\n    return 42\n");
    // The confirmation flips the control's face.
    expect(await screen.findByTitle("Copied")).toBeTruthy();
    expect(container.querySelectorAll(".codebox__copy")).toHaveLength(1);
  });

  it("never puts a copy control on inline code chips", () => {
    const { container } = render(
      <AnswerMarkdown
        text={"Use the `useRef` hook and the `useState` hook."}
        streaming={false}
      />,
    );
    expect(container.querySelector(".codebox__copy")).toBeNull();
  });

  it("colors code tokens via highlight classes", () => {
    const { container } = render(
      <AnswerMarkdown
        text={'```js\nconst greeting = "hello";\nreturn greeting;\n```'}
        streaming={false}
      />,
    );
    // rehype-highlight stamps hljs token spans the pill.css palette colors.
    expect(container.querySelector(".hljs-keyword")).not.toBeNull();
    expect(container.querySelector(".hljs-string")).not.toBeNull();
  });

  it("still renders bold and inline code as elements, never literal asterisks", () => {
    const { container } = render(
      <AnswerMarkdown
        text={"Use **exactly** the `useRef` hook."}
        streaming={false}
      />,
    );
    expect(container.querySelector(".md strong")?.textContent).toBe("exactly");
    expect(container.querySelector(".md code")?.textContent).toBe("useRef");
    expect(container.textContent).not.toContain("**");
  });

  // The speakable-wrap contract (2026-08-20): pill.css makes ```text and bare
  // fences wrap like a highlighted paragraph via `.md pre code.language-text`
  // and `.md pre code:not([class])`. jsdom cannot compute `:has()` styles, so
  // these pin the DOM classes those selectors key on — if either shape
  // changes, the wrap rules silently stop applying and this suite says so.
  it("tags a ```text fence as code.language-text — the wrap selector's hook", () => {
    const { container } = render(
      <AnswerMarkdown
        text={
          "```text\nI led the migration, and it cut deploy time in half.\n```"
        }
        streaming={false}
      />,
    );
    const code = container.querySelector(".md pre code");
    expect(code?.classList.contains("language-text")).toBe(true);
    // rehype-highlight knows `text` (plaintext alias) and stamps `hljs` too —
    // the selector must keep matching alongside it.
    expect(code?.classList.contains("hljs")).toBe(true);
  });

  it("leaves a bare fence's code CLASSLESS — the other wrap selector", () => {
    const { container } = render(
      <AnswerMarkdown
        text={"```\nSpeakable line with no tag.\n```"}
        streaming={false}
      />,
    );
    const code = container.querySelector(".md pre code");
    expect(code).not.toBeNull();
    // rehype-highlight early-returns without a language- class; react-markdown
    // adds none for a bare fence. No class attribute at all.
    expect(code?.hasAttribute("class")).toBe(false);
  });

  it("keeps the language class on real code fences, so they stay scrollable", () => {
    const { container } = render(
      <AnswerMarkdown
        text={"```python\ndef solve():\n    return 42\n```"}
        streaming={false}
      />,
    );
    const code = container.querySelector(".md pre code");
    expect(code?.classList.contains("language-python")).toBe(true);
    // Inline chips live OUTSIDE `.md pre` — the classless-wrap selector is
    // scoped under `pre` exactly so it can never catch them.
    const { container: inline } = render(
      <AnswerMarkdown text={"Use the `useRef` hook."} streaming={false} />,
    );
    const chip = inline.querySelector(".md code");
    expect(chip?.closest("pre")).toBeNull();
  });
});
