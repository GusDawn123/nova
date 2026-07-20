import fastifyWebsocket, { type WebSocket } from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RawData } from "ws";
import { z } from "zod";

import { authenticateToken, extractBearerToken } from "../../plugins/auth.js";
import { LiveSession } from "./session.js";

/**
 * The live-call WebSocket transport: `GET /live`. This is the ONLY file that
 * touches `ws` — it authenticates the upgrade, adapts raw socket events onto a
 * transport-agnostic {@link LiveSession}, and guarantees teardown runs once.
 *
 * It registers `@fastify/websocket` in its own scope, then declares the route:
 * the plugin uses fastify-plugin, so awaiting the register guarantees the
 * onRoute hook is installed before `{ websocket: true }` is declared below.
 */

/** WS close codes (4000–4999 = application-defined). */
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_UNAVAILABLE = 4503;
const CLOSE_NORMAL = 1000;

/**
 * Token from `?token=` — the FALLBACK for React Native clients that can set a
 * header but where a query param is easier. SECURITY: this value must never be
 * logged (query strings leak into access logs); nothing here logs `req`.
 */
const queryTokenSchema = z.object({ token: z.string().min(1).optional() });

function readQueryToken(req: FastifyRequest): string | undefined {
  const result = queryTokenSchema.safeParse(req.query);
  return result.success ? result.data.token : undefined;
}

/** Normalize a `ws` message payload to a single Buffer. */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export async function liveRoutes(app: FastifyInstance): Promise<void> {
  // Register the WS plugin inside this scope, then the route: fastify-plugin
  // makes `{ websocket: true }` available here, and awaiting guarantees the
  // onRoute hook is installed before the route below is added.
  await app.register(fastifyWebsocket);

  app.get("/live", { websocket: true }, (socket: WebSocket, req) => {
    // Header is primary; query param is the documented fallback.
    const token =
      extractBearerToken(req.headers.authorization) ?? readQueryToken(req);

    // The session doesn't exist until auth resolves (below), but auth can be
    // network-bound (JWKS fetch). Listeners are attached SYNCHRONOUSLY here so a
    // frame that arrives during the auth window is buffered, not lost, and an
    // early disconnect is remembered. Nothing is processed until the session is
    // live.
    let session: LiveSession | null = null;
    let closedEarly = false;
    const pending: { buf: Buffer; isBinary: boolean }[] = [];

    const deliver = (target: LiveSession, buf: Buffer, isBinary: boolean) => {
      if (isBinary) target.handleBinaryMessage(buf);
      else target.handleTextMessage(buf.toString("utf8"));
    };

    socket.on("message", (data: RawData, isBinary: boolean) => {
      const buf = toBuffer(data);
      if (session) deliver(session, buf, isBinary);
      else pending.push({ buf, isBinary });
    });
    socket.on("close", () => {
      closedEarly = true;
      session?.close();
    });
    socket.on("error", () => {
      closedEarly = true;
      session?.close();
    });

    // Auth happens post-upgrade: a WS has no clean HTTP 401 once upgraded, so a
    // failure is a policy close with an app code (4401/4503) + reason.
    void authenticateToken(token).then((auth) => {
      if (!auth.ok) {
        socket.close(
          auth.reason === "unavailable"
            ? CLOSE_UNAVAILABLE
            : CLOSE_UNAUTHORIZED,
          auth.reason,
        );
        return;
      }

      session = new LiveSession({
        send: (event) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify(event));
          }
        },
        // echo mode is a test affordance only — never honored in production.
        allowEcho: process.env.NODE_ENV !== "production",
      });

      // Closing the socket is itself a session-scoped resource. Registering it
      // means `session.end` (→ disposer.dispose) also closes the socket, and a
      // transport-driven close/error runs the disposer — exactly once, since
      // dispose is idempotent (the resulting `close` event re-entry no-ops).
      session.disposer.add(() => {
        if (socket.readyState === socket.OPEN) socket.close(CLOSE_NORMAL);
      });

      // The client may have already gone away while auth was in flight — dispose
      // now (the close handler above ran before `session` existed).
      if (closedEarly) {
        session.close();
        return;
      }

      for (const frame of pending) deliver(session, frame.buf, frame.isBinary);
      pending.length = 0;
    });
  });
}
