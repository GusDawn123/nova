import { describe, expect, it } from "vitest";

import { themeVariables } from "./theme";
import { cobaltPalette, paperPalette } from "./tokens";

describe("themeVariables", () => {
  it("derives the glass surface from the palette's own canvas", () => {
    expect(themeVariables(paperPalette)["--nova-canvas-glass"]).toBe(
      "rgba(255,255,255,0.86)",
    );
    expect(themeVariables(cobaltPalette)["--nova-canvas-glass"]).toBe(
      "rgba(0,2,218,0.86)",
    );
  });

  it("still paints the two poles the duotone spine names", () => {
    const vars = themeVariables(paperPalette);
    expect(vars["--nova-canvas"]).toBe("#FFFFFF");
    expect(vars["--nova-ink"]).toBe("#0002DA");
  });
});
