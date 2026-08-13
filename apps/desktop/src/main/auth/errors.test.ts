import { describe, expect, it } from "vitest";

import {
  authActionResultSchema,
  classifyAuthError,
  classifyThrown,
  unavailableResult,
} from "./errors";

/**
 * The status→kind mapping is what the sign-in form's copy hangs off: a 400 has
 * to read as "check your password" and a dead network has to read as "check your
 * connection". Getting them the wrong way round is invisible to a type checker
 * and obvious to a user, so it is pinned here.
 */

describe("classifyAuthError", () => {
  it("reports success for no error", () => {
    expect(classifyAuthError(null)).toEqual({ ok: true });
  });

  it.each([400, 401, 422])(
    "maps HTTP %i to invalid-credentials",
    (status: number) => {
      expect(
        classifyAuthError({ status, message: "Invalid login credentials" }),
      ).toEqual({
        ok: false,
        kind: "invalid-credentials",
        message: "Invalid login credentials",
      });
    },
  );

  it.each([429, 500, 503])("maps HTTP %i to unknown", (status: number) => {
    // A rate limit or a Supabase outage is not the user's typo. Telling them
    // their password is wrong would send them to reset a password that works.
    expect(classifyAuthError({ status, message: "upstream failure" })).toEqual({
      ok: false,
      kind: "unknown",
      message: "upstream failure",
    });
  });

  it("treats a status-less error as unknown", () => {
    expect(classifyAuthError({ message: "no status here" })).toEqual({
      ok: false,
      kind: "unknown",
      message: "no status here",
    });
  });

  it("substitutes a sentence when the error carries an empty message", () => {
    const result = classifyAuthError({ status: 400, message: "" });
    expect(result).toEqual({
      ok: false,
      kind: "invalid-credentials",
      message: "Invalid credentials",
    });
  });
});

/**
 * The offline path, which is easy to get wrong because it does not look like
 * one. supabase-js does NOT throw when the network is down: its fetch layer
 * raises `AuthRetryableFetchError` and `GoTrueClient` catches it and RETURNS it,
 * because it is an `AuthError`. So the offline case arrives as a returned value
 * and must not fall through to `unknown` — a user with no wifi should be told
 * that, not "Something went wrong".
 */
describe("classifyAuthError — a returned transport failure", () => {
  it("maps an explicit status 0 to network", () => {
    expect(
      classifyAuthError({ status: 0, message: "Failed to fetch" }),
    ).toEqual({
      ok: false,
      kind: "network",
      message: "Failed to fetch",
    });
  });

  it("maps the SDK's retryable error by name, whatever its status", () => {
    // The same class carries the 5xx statuses too, so the name has to win over
    // the status check that would otherwise call this a server problem.
    expect(
      classifyAuthError({
        name: "AuthRetryableFetchError",
        status: 503,
        message: "Service temporarily unavailable",
      }),
    ).toMatchObject({ ok: false, kind: "network" });
  });

  it("does NOT treat a merely status-less error as a network failure", () => {
    // The distinction the implementation turns on: an explicit zero is the
    // SDK's dead-fetch signal, an absent status is just an error without one.
    expect(classifyAuthError({ message: "no status" })).toMatchObject({
      kind: "unknown",
    });
  });

  it("falls back to a sentence when a transport failure carries no message", () => {
    expect(classifyAuthError({ status: 0, message: "" })).toEqual({
      ok: false,
      kind: "network",
      message: "Network request failed",
    });
  });
});

describe("classifyThrown", () => {
  it("maps a thrown Error to network, keeping its message", () => {
    expect(classifyThrown(new TypeError("fetch failed"))).toEqual({
      ok: false,
      kind: "network",
      message: "fetch failed",
    });
  });

  it.each([
    ["a string", "boom"],
    ["undefined", undefined],
    ["a plain object", { nope: true }],
    // An Error carrying nothing to say still has to produce a sentence — an
    // empty alert box is worse than a generic one.
    ["an Error with an empty message", new Error("")],
  ])("maps %s to network with a fallback message", (_label, thrown) => {
    expect(classifyThrown(thrown)).toEqual({
      ok: false,
      kind: "network",
      message: "Network request failed",
    });
  });
});

describe("the result contract", () => {
  it("accepts every classification the module can produce", () => {
    const produced = [
      classifyAuthError(null),
      classifyAuthError({ status: 400, message: "bad" }),
      classifyAuthError({ status: 500, message: "worse" }),
      classifyThrown(new Error("offline")),
      unavailableResult("Supabase is not configured"),
    ];

    for (const result of produced) {
      expect(authActionResultSchema.safeParse(result).success).toBe(true);
    }
  });

  it("rejects a failure that forgot its kind", () => {
    expect(
      authActionResultSchema.safeParse({ ok: false, message: "no kind" })
        .success,
    ).toBe(false);
  });
});
