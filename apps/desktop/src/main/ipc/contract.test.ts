import { describe, expect, it } from "vitest";

import {
  authStateMessageSchema,
  credentialsSchema,
  liveSessionEventSchema,
  meResultMessageSchema,
} from "./contract";

/**
 * The renderer is untrusted, so this is the parse that stands between it and
 * Supabase. `contextIsolation` protects main's objects from the renderer; it
 * does nothing about what the renderer SENDS, and the handler's TypeScript
 * signature is a description of intent, not a guarantee about the wire.
 */

const USER_ID = "11111111-1111-4111-8111-111111111111";

describe("credentialsSchema", () => {
  it("accepts a well-formed pair", () => {
    const parsed = credentialsSchema.safeParse({
      email: "dev@nova.test",
      password: "nova-dev-1234",
    });

    expect(parsed.success).toBe(true);
  });

  it.each([
    ["a missing password", { email: "dev@nova.test" }],
    ["a missing email", { password: "nova-dev-1234" }],
    ["an empty password", { email: "dev@nova.test", password: "" }],
    ["a malformed email", { email: "not-an-email", password: "x" }],
    ["a non-string password", { email: "dev@nova.test", password: 1234 }],
    ["a nested object", { email: { $ne: null }, password: "x" }],
    ["null", null],
    ["undefined", undefined],
    ["a bare string", "dev@nova.test"],
    ["an array", ["dev@nova.test", "nova-dev-1234"]],
  ])("rejects %s", (_label, payload) => {
    expect(credentialsSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects unexpected keys rather than ignoring them", () => {
    // An extra field means the two sides disagree about the contract. Silently
    // dropping it is how a renderer starts sending something main stopped
    // reading without anybody noticing.
    const parsed = credentialsSchema.safeParse({
      email: "dev@nova.test",
      password: "nova-dev-1234",
      role: "admin",
    });

    expect(parsed.success).toBe(false);
  });
});

describe("authStateMessageSchema", () => {
  it.each([
    [{ status: "loading" }],
    [{ status: "unavailable", message: "no config" }],
    [{ status: "signed-out" }],
    [{ status: "signed-in", user: { id: USER_ID } }],
    [{ status: "signed-in", user: { id: USER_ID, email: "dev@nova.test" } }],
  ])("accepts %o", (state) => {
    expect(authStateMessageSchema.safeParse(state).success).toBe(true);
  });

  it.each([
    ["an unknown status", { status: "pending" }],
    ["signed-in with no user", { status: "signed-in" }],
    ["unavailable with no message", { status: "unavailable" }],
    ["no status at all", { user: { id: USER_ID } }],
  ])("rejects %s", (_label, state) => {
    expect(authStateMessageSchema.safeParse(state).success).toBe(false);
  });

  it("carries no access token in any branch", () => {
    // The renderer is never handed a token — that is the whole reason the state
    // is a projection of the Supabase session instead of the session itself.
    const parsed = authStateMessageSchema.parse({
      status: "signed-in",
      user: { id: USER_ID, email: "dev@nova.test" },
      access_token: "should-be-stripped",
    });

    expect(JSON.stringify(parsed)).not.toContain("should-be-stripped");
  });
});

describe("liveSessionEventSchema — the suggestion variant", () => {
  it.each(["start", "delta", "done", "discard"] as const)(
    "accepts phase %s",
    (phase) => {
      const parsed = liveSessionEventSchema.safeParse({
        kind: "suggestion",
        phase,
        id: "s-1",
        text: "body",
      });
      expect(parsed.success).toBe(true);
    },
  );

  it.each([
    [
      "an unknown phase",
      { kind: "suggestion", phase: "pause", id: "s", text: "" },
    ],
    ["a missing id", { kind: "suggestion", phase: "delta", text: "x" }],
    ["a missing text", { kind: "suggestion", phase: "delta", id: "s" }],
    [
      "an unexpected key",
      { kind: "suggestion", phase: "start", id: "s", text: "", zombie: true },
    ],
  ])("rejects %s", (_label, payload) => {
    expect(liveSessionEventSchema.safeParse(payload).success).toBe(false);
  });
});

describe("meResultMessageSchema", () => {
  it("accepts a success carrying a valid /me body", () => {
    const parsed = meResultMessageSchema.safeParse({
      ok: true,
      data: { user_id: USER_ID, email: "dev@nova.test", role: "developer" },
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects a success carrying an invalid /me body", () => {
    const parsed = meResultMessageSchema.safeParse({
      ok: true,
      data: { user_id: "not-a-uuid" },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects a failure with an error kind the client cannot produce", () => {
    const parsed = meResultMessageSchema.safeParse({
      ok: false,
      kind: "teapot",
      message: "no",
    });

    expect(parsed.success).toBe(false);
  });
});
