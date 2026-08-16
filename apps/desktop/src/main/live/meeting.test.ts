import { describe, expect, it, vi } from "vitest";

import { createMeetingRow, type CreateMeetingDeps } from "./meeting";

const MEETING_ID = "11111111-2222-4333-8444-555555555555";

function deps(fetchImpl: CreateMeetingDeps["fetch"]): CreateMeetingDeps {
  return {
    supabaseUrl: "http://127.0.0.1:54321/",
    anonKey: "anon-key",
    accessToken: "token-1",
    userId: "user-1",
    fetch: fetchImpl,
  };
}

describe("createMeetingRow", () => {
  it("POSTs the row with the user's own credentials and returns its id", async () => {
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(() =>
      Promise.resolve(
        new Response(JSON.stringify([{ id: MEETING_ID }]), { status: 201 }),
      ),
    );
    const result = await createMeetingRow(deps(fetchMock));
    expect(result).toEqual({ ok: true, meetingId: MEETING_ID });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    // The trailing slash on supabaseUrl must not double up.
    expect(url).toBe("http://127.0.0.1:54321/rest/v1/meetings");
    const headers = new Headers(init?.headers);
    expect(headers.get("apikey")).toBe("anon-key");
    expect(headers.get("authorization")).toBe("Bearer token-1");
    expect(headers.get("prefer")).toBe("return=representation");
    if (typeof init?.body !== "string") throw new Error("expected a string body");
    const body: unknown = JSON.parse(init.body);
    expect(body).toMatchObject({ user_id: "user-1" });
  });

  it("fails typed on a non-OK response", async () => {
    const result = await createMeetingRow(
      deps(() => Promise.resolve(new Response("denied", { status: 403 }))),
    );
    expect(result).toEqual({
      ok: false,
      message: "Could not create the meeting (403).",
    });
  });

  it("fails typed when the response body is not the inserted row", async () => {
    const result = await createMeetingRow(
      deps(() =>
        Promise.resolve(
          new Response(JSON.stringify({ weird: true }), { status: 201 }),
        ),
      ),
    );
    expect(result).toEqual({
      ok: false,
      message: "The meeting was created but its id could not be read.",
    });
  });

  it("fails typed when fetch itself rejects (server unreachable)", async () => {
    const result = await createMeetingRow(
      deps(() => Promise.reject(new Error("ECONNREFUSED"))),
    );
    expect(result).toEqual({
      ok: false,
      message: "Could not create the meeting (ECONNREFUSED).",
    });
  });
});
