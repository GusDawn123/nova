import { describe, expect, it } from "vitest";

import { isSameDocumentNavigation } from "./main-window";

/**
 * The navigation guard is a security boundary: a renderer that can navigate
 * away replaces our UI with a document that then sits behind the same preload
 * bridge. `contextIsolation` and `sandbox` limit what the renderer can DO, and
 * neither limits where it can GO.
 *
 * Dev and production are genuinely different cases rather than one case with a
 * quirk, so both are pinned here. Under the dev server the two URLs share an
 * http origin; in a packaged build both are `file://`, whose origin serialises
 * to the string `"null"` — comparing origins there would accept every file on
 * the disk.
 */
describe("isSameDocumentNavigation", () => {
  const DEV = "http://localhost:5173/index.html";
  const PACKAGED = "file:///C:/Program%20Files/Nova/renderer/index.html";

  it("allows the dev server reloading its own document", () => {
    expect(
      isSameDocumentNavigation("http://localhost:5173/index.html", DEV),
    ).toBe(true);
    // HMR reconnects with a query string; same document, same origin.
    expect(
      isSameDocumentNavigation("http://localhost:5173/index.html?v=2", DEV),
    ).toBe(true);
  });

  it("allows a packaged build reloading its own file", () => {
    expect(isSameDocumentNavigation(PACKAGED, PACKAGED)).toBe(true);
  });

  it.each([
    ["a remote page", "https://evil.example/phish"],
    ["plain http elsewhere", "http://evil.example/"],
    ["a different dev port", "http://localhost:9999/index.html"],
    ["a custom scheme", "nova-evil://open"],
    ["a javascript: url", "javascript:alert(1)"],
    ["a data: url", "data:text/html,<script>alert(1)</script>"],
  ])("blocks %s from the dev document", (_label, target) => {
    expect(isSameDocumentNavigation(target, DEV)).toBe(false);
  });

  it("blocks a different file on disk, which origin comparison alone would allow", () => {
    // Both origins serialise to "null" here. This is the case that makes the
    // packaged branch necessary rather than merely tidy.
    expect(
      isSameDocumentNavigation("file:///C:/Users/someone/evil.html", PACKAGED),
    ).toBe(false);
  });

  it("never treats file and http as the same document in either direction", () => {
    expect(isSameDocumentNavigation(PACKAGED, DEV)).toBe(false);
    expect(isSameDocumentNavigation(DEV, PACKAGED)).toBe(false);
  });

  it("refuses anything it cannot parse", () => {
    // Default deny: an unparseable target is not a target we recognise.
    expect(isSameDocumentNavigation("not a url", DEV)).toBe(false);
    expect(isSameDocumentNavigation(DEV, "")).toBe(false);
  });
});
