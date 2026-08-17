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
});
