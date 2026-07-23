import fastifyWebsocket, { type WebSocket } from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RawData } from "ws";
import { z } from "zod";

import { isSupabaseConfigured } from "../../db/client.js";
import { isJobStoreConfigured, notesJobStoreFromEnv } from "../../db/jobs.js";
import { createTranscriptPersister } from "../../db/transcripts.js";
import { isNotesWorkerEnabled } from "../../env.js";
import { maybeCreateLiveMetering } from "../../metering-wiring.js";
import { authenticateToken, extractBearerToken } from "../../plugins/auth.js";
import { meteringConfig } from "../metering/index.js";
import { defaultSttConfig } from "../stt/config.js";
import { createSttEngine } from "../stt/engine.js";
import { createSttVendorsFromEnv } from "../stt/vendors.js";
import { createInMemorySessionRegistry } from "./ports.js";
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

/** WS close codes (1009 = RFC 6455 "message too big"; 4xxx = app-defined). */
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_UNAVAILABLE = 4503;
const CLOSE_NORMAL = 1000;
const CLOSE_TOO_MUCH_BUFFERED = 1009;

/**
 * Cap on frames buffered from a NOT-YET-AUTHENTICATED client while token
 * verification is in flight (the auth window is JWKS-fetch-bound, so it can be
 * network-slow). 64 frames ≈ several seconds of 40–80ms audio — far more than a
 * legit client sends before `session.ready` — while bounding what an
 * unauthenticated socket can make us hold in memory. Past the cap: policy-close
 * 1009 and stop buffering.
 */
const MAX_PENDING_FRAMES = 64;

/**
 * Per-message byte cap for the socket. Audio frames are ~2.5KB (16kHz PCM,
 * 40–80ms); 64KB is a generous ceiling that still bounds a single hostile frame
 * (a `ws`-level 1009 close) instead of letting one message balloon memory.
 */
const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Token from `?token=` — the FALLBACK for React Native clients that can set a
 * header but where a query param is easier. SECURITY: this value must never be
 * logged. Query strings leak through pino's default req serializer, so buildApp
 * installs the redacting serializer from `plugins/log-redaction.ts` globally
 * (tested there); nothing in this module logs `req` either.
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
  await app.register(fastifyWebsocket, {
    options: { maxPayload: MAX_PAYLOAD_BYTES },
  });

  // One engine over the env-configured vendor lineup, shared across connections
  // (it is a factory of per-session handles). No vendors yet (Task 5) → a
  // started session emits a single typed `error` instead of hanging. The lineup
  // HEAD also seeds the session's pre-failover usage attribution (Phase 6).
  const sttVendors = createSttVendorsFromEnv(process.env);
  const sttEngine = createSttEngine(defaultSttConfig, sttVendors);
  const initialSttVendor = sttVendors[0]?.id;

  // Metering + quota seam (Phase 6, adr-0007 §3/§4). Wired only when the DB is
  // configured — a keyless/DB-less dev boot skips enforcement exactly as it
  // skips persistence (the seams-optional posture).
  const metering = maybeCreateLiveMetering(app);

  // ONE live session per user (Phase 6, adr-0007 §6). Purely in-memory — no env
  // gate: concurrency needs only the authenticated identity, so it holds even on
  // keyless/DB-less boots. Single-instance by design (the logged opener).
  const registry = createInMemorySessionRegistry();

  // Durable transcript memory. Wired only when the DB is configured; otherwise the
  // session still streams to the phone, just without persistence (same keyless
  // posture as STT). A DB write never blocks the relay (fire-and-forget in the
  // session), so a slow/absent DB can never stall or drop a socket frame.
  //
  // When the notes system is enabled, `markEnded` also EAGER-enqueues a generate_notes
  // job (adr-0006 §4). The enqueue is fire-and-forget and best-effort: a failure is
  // logged (ids only) and the sweep backstop still covers the meeting. The pg-Pool job
  // store never leaks into the supabase-js persister — it is injected as a callback.
  const notesStore =
    isNotesWorkerEnabled(process.env) &&
    isJobStoreConfigured(process.env) &&
    process.env.NODE_ENV !== "test"
      ? notesJobStoreFromEnv(process.env).store
      : null;
  const persisterOptions =
    notesStore !== null
      ? {
          onEnded: (meetingId: string, userId: string): void => {
            void notesStore.enqueue(meetingId, userId).catch((err: unknown) => {
              app.log.error(
                { meeting_id: meetingId, user_id: userId, err },
                "notes.eager_enqueue_failed",
              );
            });
          },
        }
      : {};
  const persister = isSupabaseConfigured(process.env)
    ? createTranscriptPersister(persisterOptions)
    : null;

  // EXCLUDED from the REST rate limiter (adr-0007 §6): the socket has the
  // one-session-per-user concurrency cap instead, and a mid-call upgrade must
  // never be starved by unrelated REST traffic from the same caller.
  app.get(
    "/live",
    { websocket: true, config: { rateLimit: false } },
    (socket: WebSocket, req) => {
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
        if (session) {
          deliver(session, buf, isBinary);
          return;
        }
        // Unauthenticated flood guard: the buffer is bounded; a client that blows
        // past it gets a policy close instead of growing server memory. The close
        // handler flags closedEarly, so auth resolving later just disposes.
        if (pending.length >= MAX_PENDING_FRAMES) {
          socket.close(CLOSE_TOO_MUCH_BUFFERED, "too much data before auth");
          return;
        }
        pending.push({ buf, isBinary });
      });
      socket.on("close", () => {
        closedEarly = true;
        pending.length = 0; // drop anything buffered for a client that is gone
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
          sttEngine,
          // The authenticated caller. Every enforcement seam below additionally
          // gates on its OWN dependency (persister/metering/registry), so the
          // unconditional identity enables exactly the wired subset.
          userId: auth.user.id,
          // Persist finals + stamp ended_at for the authenticated owner (when the DB
          // is wired). app.log carries persistence-failure logs (ids only, no content).
          ...(persister !== null ? { persister } : {}),
          // Metering + quota (Phase 6): bill relayed stt seconds + enforce the plan
          // quota for the authenticated caller.
          ...(metering !== undefined
            ? {
                metering,
                quotaRecheckSeconds: meteringConfig.quotaRecheckSeconds,
              }
            : {}),
          // One-session-per-user cap (typed concurrent_session on a second start).
          registry,
          ...(initialSttVendor !== undefined ? { initialSttVendor } : {}),
          logger: app.log,
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

        for (const frame of pending)
          deliver(session, frame.buf, frame.isBinary);
        pending.length = 0;
      });
    },
  );
}
