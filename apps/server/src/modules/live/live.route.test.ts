import type { AddressInfo } from "node:net";

import type { ServerLiveEvent } from "@nova/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { buildApp } from "../../app.js";

/**
 * Transport-level proof over a REAL WebSocket (in-process Fastify listening on
 * an ephemeral port; a genuine `ws` client — no fake network layer). Auth is
 * stubbed to succeed so the authed protocol + teardown are covered STACK-DOWN;
 * the auth-close behavior and a real Supabase JWT are exercised in
 * live.auth.integration.test.ts.
 */
vi.mock("../../plugins/auth.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../../plugins/auth.js")>();
  return {
    ...actual,
    authenticateToken: vi.fn(() =>
      Promise.resolve({ ok: true, user: { id: "test-user" } }),
    ),
  };
});

const MEETING_ID = "11111111-1111-4111-8111-111111111111";

let app: FastifyInstance;
let wsUrl: string;

beforeEach(async () => {
  app = buildApp({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${String(address.port)}/live`;
});

afterEach(async () => {
  await app.close();
});

/** Connect and resolve once the socket is open. */
function connect(): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl, {
    headers: { authorization: "Bearer stubbed" },
  });
  return new Promise((resolve, reject) => {
    ws.on("open", () => {
      resolve(ws);
    });
    ws.on("error", reject);
  });
}

/** Next JSON event from the server. */
function nextEvent(ws: WebSocket): Promise<ServerLiveEvent> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data: Buffer) => {
      try {
        resolve(JSON.parse(data.toString("utf8")) as ServerLiveEvent);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    ws.once("error", reject);
  });
}

/** Next close event (code + decoded reason). */
function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code: number, reason: Buffer) => {
      resolve({ code, reason: reason.toString("utf8") });
    });
  });
}

const startFrame = (echo = false): string =>
  JSON.stringify({ v: 1, type: "session.start", meeting_id: MEETING_ID, echo });

describe("GET /live (authed protocol)", () => {
  it("completes the session.start -> session.ready handshake", async () => {
    const ws = await connect();
    try {
      ws.send(startFrame());
      const ready = await nextEvent(ws);
      expect(ready.type).toBe("session.ready");
      if (ready.type === "session.ready") {
        expect(ready.session_id).toMatch(/^[0-9a-f-]{36}$/);
      }
    } finally {
      ws.terminate();
    }
  });

  it("round-trips a binary audio frame in echo mode", async () => {
    const ws = await connect();
    try {
      ws.send(startFrame(true));
      await nextEvent(ws); // session.ready

      const frame = Buffer.from([1, 2, 3, 4, 5, 6, 7]);
      ws.send(frame);
      const echo = await nextEvent(ws);
      expect(echo).toEqual({ v: 1, type: "audio.echo", bytes: 7 });
    } finally {
      ws.terminate();
    }
  });

  it("answers ping with pong", async () => {
    const ws = await connect();
    try {
      ws.send(JSON.stringify({ v: 1, type: "ping" }));
      expect((await nextEvent(ws)).type).toBe("pong");
    } finally {
      ws.terminate();
    }
  });

  it("answers a malformed frame with error and keeps the socket open", async () => {
    const ws = await connect();
    try {
      ws.send("{ not json");
      const err = await nextEvent(ws);
      expect(err).toMatchObject({ type: "error", code: "invalid_json" });

      // Socket still usable: a follow-up ping is answered.
      ws.send(JSON.stringify({ v: 1, type: "ping" }));
      expect((await nextEvent(ws)).type).toBe("pong");
    } finally {
      ws.terminate();
    }
  });

  it("errors on a binary frame received before session.start", async () => {
    const ws = await connect();
    try {
      ws.send(Buffer.from([0, 1, 2]));
      expect(await nextEvent(ws)).toMatchObject({
        type: "error",
        code: "audio_before_start",
      });
    } finally {
      ws.terminate();
    }
  });

  it("tears down and closes the socket on session.end", async () => {
    const ws = await connect();
    try {
      ws.send(startFrame());
      await nextEvent(ws); // session.ready

      const closed = nextClose(ws);
      ws.send(JSON.stringify({ v: 1, type: "session.end" }));
      const { code } = await closed;
      expect(code).toBe(1000);
    } finally {
      ws.terminate();
    }
  });

  it("survives an abrupt client disconnect mid-session (clean teardown)", async () => {
    const ws = await connect();
    ws.send(startFrame());
    await nextEvent(ws); // session.ready
    // Drop the socket mid-session; the server-side disposer must fire without
    // throwing. afterEach's app.close() completing proves no lingering handles.
    ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.server.listening).toBe(true);
  });
});
