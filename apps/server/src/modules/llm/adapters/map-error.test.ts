import { describe, expect, it } from "vitest";

import { LlmError } from "../errors.js";
import { extractHttpStatus, messageOf, toLlmError } from "./map-error.js";

/**
 * All four adapters funnel their `catch` through {@link toLlmError}, so the
 * error-mapping contract (RULES: never leak a raw SDK error; auth vs transient
 * via the HTTP taxonomy) is verified once here.
 */
describe("adapters/map-error", () => {
  const notAborted = new AbortController().signal;

  it("classifies 401 and 403 as auth", () => {
    for (const status of [401, 403]) {
      const mapped = toLlmError({ status, message: "nope" }, notAborted);
      expect(mapped).toBeInstanceOf(LlmError);
      expect(mapped.kind).toBe("auth");
    }
  });

  it("classifies other HTTP statuses (429, 500) as transient", () => {
    for (const status of [429, 500, 529]) {
      expect(toLlmError({ status }, notAborted).kind).toBe("transient");
    }
  });

  it("reads status off a `statusCode` field too", () => {
    expect(toLlmError({ statusCode: 401 }, notAborted).kind).toBe("auth");
  });

  it("maps a non-HTTP transport error to transient, preserving the cause", () => {
    const raw = new Error("socket hang up");
    const mapped = toLlmError(raw, notAborted);
    expect(mapped.kind).toBe("transient");
    expect(mapped.cause).toBe(raw);
  });

  it("maps an aborted signal to an `aborted` error regardless of the thrown value", () => {
    const controller = new AbortController();
    controller.abort();
    const mapped = toLlmError(new Error("Request was aborted"), controller.signal);
    expect(mapped.kind).toBe("aborted");
  });

  it("maps a DOMException-style AbortError even without an aborted signal", () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    expect(toLlmError(abortErr, notAborted).kind).toBe("aborted");
  });

  it("passes an already-typed LlmError through untouched", () => {
    const original = LlmError.auth("bad key");
    expect(toLlmError(original, notAborted)).toBe(original);
  });

  it("extractHttpStatus ignores non-integer / absent statuses", () => {
    expect(extractHttpStatus({ status: 404 })).toBe(404);
    expect(extractHttpStatus({ status: "404" })).toBeUndefined();
    expect(extractHttpStatus({})).toBeUndefined();
    expect(extractHttpStatus(null)).toBeUndefined();
    expect(extractHttpStatus("boom")).toBeUndefined();
  });

  it("messageOf reads Error messages and stringifies the rest", () => {
    expect(messageOf(new Error("x"))).toBe("x");
    expect(messageOf("y")).toBe("y");
  });
});
