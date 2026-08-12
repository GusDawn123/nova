import { describe, expect, it } from "vitest";

import {
  createApiClient,
  type ApiClientDeps,
  type SchemaIssue,
} from "./client";

/**
 * The client's job is not "call /me" — it is to turn every way that call can go
 * wrong into words a person can act on. So the tests are mostly failures: a 401
 * and a 503 arrive over the same wire and mean opposite things, a deadline and a
 * dead network both surface as an abort, and a response that parses as JSON but
 * not as OUR schema must never put a ZodError on screen.
 *
 * `fetch` is injected, never monkey-patched onto the global — the seam exists in
 * the production type, so the test uses the same door every caller does.
 */

const USER_ID = "11111111-1111-4111-8111-111111111111";
const BASE_URL = "http://127.0.0.1:3000";

function jsonFetch(status: number, body: unknown): typeof globalThis.fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
}

/** `fetch` accepts three input shapes; only one of them stringifies usefully. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function client(overrides: Partial<ApiClientDeps> = {}) {
  return createApiClient({
    baseUrl: BASE_URL,
    fetch: jsonFetch(200, { user_id: USER_ID }),
    getAccessToken: () => Promise.resolve("access-token"),
    ...overrides,
  });
}

describe("getMe", () => {
  it("returns the parsed identity on 200", async () => {
    const result = await client({
      fetch: jsonFetch(200, {
        user_id: USER_ID,
        email: "dev@nova.test",
        role: "developer",
      }),
    }).getMe();

    expect(result).toEqual({
      ok: true,
      data: { user_id: USER_ID, email: "dev@nova.test", role: "developer" },
    });
  });

  it("sends the bearer token to the /me endpoint", async () => {
    let seenUrl: string | undefined;
    let seenAuthorization: string | null | undefined;

    await client({
      fetch: (input, init) => {
        seenUrl = urlOf(input);
        seenAuthorization = new Headers(init?.headers).get("authorization");
        return Promise.resolve(
          new Response(JSON.stringify({ user_id: USER_ID })),
        );
      },
    }).getMe();

    expect(seenUrl).toBe(`${BASE_URL}/me`);
    expect(seenAuthorization).toBe("Bearer access-token");
  });

  it("never reaches the network when nobody is signed in", async () => {
    let called = false;

    const result = await client({
      getAccessToken: () => Promise.resolve(null),
      fetch: () => {
        called = true;
        return Promise.resolve(new Response("{}"));
      },
    }).getMe();

    expect(called).toBe(false);
    expect(result).toMatchObject({ ok: false, kind: "signed-out" });
  });

  it("maps 401 to unauthorized", async () => {
    const result = await client({
      fetch: jsonFetch(401, { error: "unauthorized" }),
    }).getMe();

    expect(result).toMatchObject({ ok: false, kind: "unauthorized" });
  });

  it("maps 503 to unavailable — a different problem from a bad token", async () => {
    const result = await client({
      fetch: jsonFetch(503, { error: "unavailable" }),
    }).getMe();

    expect(result).toMatchObject({ ok: false, kind: "unavailable" });
    // The two must not collapse into one message: 401 asks the user to sign in
    // again, 503 says the server itself is not ready.
    const unauthorized = await client({
      fetch: jsonFetch(401, { error: "unauthorized" }),
    }).getMe();
    expect(result).not.toEqual(unauthorized);
  });

  it("maps any other non-2xx to server, naming the status", async () => {
    const result = await client({
      fetch: jsonFetch(500, { error: "internal" }),
    }).getMe();

    expect(result).toMatchObject({ ok: false, kind: "server" });
    expect(result.ok ? "" : result.message).toContain("500");
  });

  it("distinguishes a deadline from a dead network", async () => {
    const hangs: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });

    const timedOut = await client({ fetch: hangs, timeoutMs: 10 }).getMe();
    const offline = await client({
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    }).getMe();

    expect(timedOut).toMatchObject({ ok: false, kind: "timeout" });
    expect(offline).toMatchObject({ ok: false, kind: "network" });
  });

  it("treats a body that is not JSON as a transport failure", async () => {
    const result = await client({
      fetch: () => Promise.resolve(new Response("<html>nope</html>")),
    }).getMe();

    expect(result).toMatchObject({ ok: false, kind: "network" });
  });

  it("surfaces a schema mismatch as fixed copy, not a ZodError", async () => {
    const result = await client({
      fetch: jsonFetch(200, { user_id: "not-a-uuid", role: "wizard" }),
    }).getMe();

    expect(result).toMatchObject({ ok: false, kind: "schema" });
    const message = result.ok ? "" : result.message;
    expect(message).not.toContain("not-a-uuid");
    expect(message).not.toContain("invalid_string");
  });

  it("logs schema issues as paths and codes, never values", async () => {
    const logged: SchemaIssue[][] = [];

    await client({
      fetch: jsonFetch(200, { user_id: "not-a-uuid", email: "leak@nova.test" }),
      onSchemaIssue: (_endpoint, issues) => logged.push(issues),
    }).getMe();

    const [issues] = logged;
    expect(issues).toBeDefined();
    expect(issues?.map((issue) => issue.path)).toContain("user_id");
    // The whole point of the digest: nothing that came off the wire is in it.
    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain("not-a-uuid");
    expect(serialized).not.toContain("leak@nova.test");
  });
});
