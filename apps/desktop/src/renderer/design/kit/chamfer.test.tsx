/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Chamfer, chamferClipPath } from "./chamfer";
import { Scanlines } from "./scanlines";

afterEach(cleanup);

describe("chamferClipPath", () => {
  it("cuts the top-left and bottom-right corners, absolute at any size", () => {
    expect(chamferClipPath(8)).toBe(
      "polygon(8px 0, 100% 0, 100% calc(100% - 8px), " +
        "calc(100% - 8px) 100%, 0 100%, 0 8px)",
    );
  });
});

describe("Chamfer", () => {
  it("renders children inside the two clipped layers", () => {
    render(<Chamfer className="mine">hello</Chamfer>);

    const content = screen.getByText("hello");
    expect(content.className).toBe("nova-chamfer__fill");
    expect(content.parentElement?.className).toBe("nova-chamfer mine");
    // both layers wear the same silhouette, so the outline follows the cut
    expect(content.style.clipPath).toBe(content.parentElement?.style.clipPath);
  });

  it("the key cut is larger than the control cut", () => {
    render(
      <>
        <Chamfer cut="control">a</Chamfer>
        <Chamfer cut="key">b</Chamfer>
      </>,
    );

    const control = screen.getByText("a").style.clipPath;
    const key = screen.getByText("b").style.clipPath;
    expect(control).toContain("8px");
    expect(key).toContain("10px");
  });
});

describe("Scanlines", () => {
  it("is invisible to assistive tech: atmosphere, not information", () => {
    render(<Scanlines className="over-the-panel" />);

    const layer = document.querySelector(".nova-scanlines");
    expect(layer).not.toBeNull();
    expect(layer?.getAttribute("aria-hidden")).toBe("true");
    expect(layer?.className).toBe("nova-scanlines over-the-panel");
  });
});
