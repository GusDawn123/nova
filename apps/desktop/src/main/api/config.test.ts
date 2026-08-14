import { describe, expect, it } from "vitest";

import { DEFAULT_API_BASE_URL, resolveApiBaseUrl } from "./config";

/**
 * These values are inlined at BUILD time, so every failure here is a broken
 * build rather than anything a user did — which is exactly why the two modes
 * are held to different bars. Development guesses so the app runs with no
 * `.env`; production refuses, because a packaged app quietly pointing at
 * `127.0.0.1` looks broken to a customer for a reason no log explains.
 */
describe("resolveApiBaseUrl", () => {
  const PROD = false;
  const DEV = true;

  it("takes a valid https url in either mode", () => {
    expect(resolveApiBaseUrl("https://api.nova.app", PROD)).toBe(
      "https://api.nova.app",
    );
    expect(resolveApiBaseUrl("https://api.nova.app", DEV)).toBe(
      "https://api.nova.app",
    );
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["not a url", "api.nova.app"],
    ["a number", 3000],
  ])("falls back to the local server in development when %s", (_label, raw) => {
    expect(resolveApiBaseUrl(raw, DEV)).toBe(DEFAULT_API_BASE_URL);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["not a url", "api.nova.app"],
  ])("refuses to guess in production when %s", (_label, raw) => {
    expect(() => resolveApiBaseUrl(raw, PROD)).toThrow(/NOVA_API_URL/);
  });

  it("rejects plain http off loopback in production", () => {
    // Every request carries a bearer token in a header.
    expect(() => resolveApiBaseUrl("http://api.nova.app", PROD)).toThrow(
      /https/,
    );
  });

  it("still allows loopback over http in production", () => {
    // A locally-run server is the one case where the token never leaves the
    // machine, and it is how a developer tests a packaged build.
    expect(resolveApiBaseUrl("http://127.0.0.1:3000", PROD)).toBe(
      "http://127.0.0.1:3000",
    );
    expect(resolveApiBaseUrl("http://localhost:3000", PROD)).toBe(
      "http://localhost:3000",
    );
  });

  it("allows plain http anywhere in development", () => {
    expect(resolveApiBaseUrl("http://staging.internal:3000", DEV)).toBe(
      "http://staging.internal:3000",
    );
  });
});
