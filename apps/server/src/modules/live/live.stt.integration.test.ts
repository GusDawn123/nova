import type { AddressInfo } from "node:net";

import type { ServerLiveEvent } from "@nova/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { buildApp } from "../../app.js";
import type { SttVendor } from "../stt/ports.js";
import { MockVendor } from "../stt/testing/mock-vendor.js";

/**
 * Integration proof of the STT relay wired into the /live socket: in-process
 * Fastify + a real `ws` client, with MOCK vendors injected through the
 * `createSttVendorsFromEnv` registry seam (same DI shape the transport uses for
 * `authenticateToken`, stubbed here so the authed path runs stack-down).
 *
 * Covers the full path (binary frame → vendor → transcript.partial/final down the
 * socket), an invisible mid-call reconnect (no error/switch reaches the client),
 * and the money-leak rule: a dropped socket aborts the vendor connection.
 */

// The vendor lineup the transport builds its engine over. Set per test BEFORE
// buildApp; the mock is a thin passthrough to this hoisted container.
const vendorRegistry = vi.hoisted(() => ({ lineup: [] as SttVendor[] }));

vi.mock("../stt/vendors.js", () => ({
  createSttVendorsFromEnv: (): readonly SttVendor[] => vendorRegistry.lineup,
}));

vi.mock("../../plugins/auth.js", async (importActual) => {
  const actual = await importActual<typeof import("../../plugins/auth.js")>();
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

/** Boot the app over a given vendor lineup and return the /live URL. */
async function boot(lineup: SttVendor[]): Promise<void> {
  vendorRegistry.lineup = lineup;
  app = buildApp({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${String(address.port)}/live`;
}

afterEach(async () => {
  await app.close();
  vendorRegistry.lineup = [];
});

/** Connect (auth header stubbed to succeed) and resolve once open. */
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

/** Accumulate every JSON event the server sends; also expose a waiter. */
function collect(ws: WebSocket): {
  events: ServerLiveEvent[];
  waitFor: (type: ServerLiveEvent["type"], ms?: number) => Promise<ServerLiveEvent>;
} {
  const events: ServerLiveEvent[] = [];
  ws.on("message", (data: Buffer) => {
    events.push(JSON.parse(data.toString("utf8")) as ServerLiveEvent);
  });
  const waitFor = (type: ServerLiveEvent["type"], ms = 2000): Promise<ServerLiveEvent> =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = (): void => {
        const found = events.find((e) => e.type === type);
        if (found) {
          resolve(found);
          return;
        }
        if (Date.now() - started > ms) {
          reject(new Error(`timed out waiting for ${type}`));
          return;
        }
        setTimeout(tick, 5);
      };
      tick();
    });
  return { events, waitFor };
}

const startFrame = JSON.stringify({
  v: 1,
  type: "session.start",
  meeting_id: MEETING_ID,
});

/** Poll a predicate until true or timeout. */
function until(predicate: () => boolean, ms = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > ms) {
        reject(new Error("condition not met in time"));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe("GET /live STT relay", () => {
  it("streams a binary frame to the vendor and relays partial then final", async () => {
    const vendor = new MockVendor({
      id: "assemblyai",
      connections: [
        {
          events: [
            { afterMs: 5, event: { type: "partial", text: "hel", speaker: null, ts_ms: 100 } },
            {
              afterMs: 5,
              event: { type: "final", text: "hello there", speaker: "spk_0", ts_ms: 200 },
            },
          ],
          terminal: "hang",
        },
      ],
    });
    await boot([vendor]);

    const ws = await connect();
    const { events, waitFor } = collect(ws);
    try {
      ws.send(startFrame);
      await waitFor("session.ready");

      const frame = Buffer.from([1, 2, 3, 4]);
      ws.send(frame);

      const partial = await waitFor("transcript.partial");
      const final = await waitFor("transcript.final");

      expect(partial).toMatchObject({ type: "transcript.partial", text: "hel" });
      expect(final).toEqual({
        v: 1,
        type: "transcript.final",
        text: "hello there",
        speaker: "spk_0",
        ts_ms: 200,
        is_final: true,
      });
      // The binary frame actually reached the vendor connection.
      await until(() => (vendor.connections[0]?.framesReceived.length ?? 0) > 0);
      expect(vendor.connections[0]?.framesReceived).toContainEqual(frame);
      expect(events.some((e) => e.type === "error")).toBe(false);
    } finally {
      ws.terminate();
    }
  });

  it("reconnects the vendor mid-call invisibly (client sees no error or switch)", async () => {
    const vendor = new MockVendor({
      id: "assemblyai",
      connections: [
        {
          events: [
            { afterMs: 5, event: { type: "partial", text: "one", speaker: null, ts_ms: 10 } },
            { afterMs: 5, event: { type: "closed" } },
          ],
          terminal: "close",
        },
        {
          events: [
            { afterMs: 5, event: { type: "final", text: "two", speaker: null, ts_ms: 20 } },
          ],
          terminal: "hang",
        },
      ],
    });
    await boot([vendor]);

    const ws = await connect();
    const { events, waitFor } = collect(ws);
    try {
      ws.send(startFrame);
      await waitFor("session.ready");
      await waitFor("transcript.partial");

      // The default backoff is 250ms; the reconnect + second connection's final
      // arrives after it, with no error/provider_switched in between.
      const final = await waitFor("transcript.final");
      expect(final).toMatchObject({ type: "transcript.final", text: "two" });
      expect(vendor.connectAttempts).toBe(2);
      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(events.some((e) => e.type === "provider_switched")).toBe(false);
    } finally {
      ws.terminate();
    }
  });

  it("aborts the vendor connection when the socket drops (money-leak rule)", async () => {
    const vendor = new MockVendor({
      id: "assemblyai",
      connections: [
        {
          events: [
            { afterMs: 5, event: { type: "partial", text: "live", speaker: null, ts_ms: 1 } },
          ],
          terminal: "hang",
        },
      ],
    });
    await boot([vendor]);

    const ws = await connect();
    const { waitFor } = collect(ws);
    ws.send(startFrame);
    await waitFor("session.ready");
    await waitFor("transcript.partial"); // connection is live

    ws.terminate(); // phone drops mid-call

    // The disposer must abort the vendor socket, not leak it.
    await until(() => vendor.connections[0]?.isClosed === true);
    expect(vendor.connections[0]?.isClosed).toBe(true);
  });
});
