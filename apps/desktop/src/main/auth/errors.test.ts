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
