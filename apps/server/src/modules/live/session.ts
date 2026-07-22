import { randomUUID } from "node:crypto";

import {
  LIVE_PROTOCOL_VERSION,
  parseClientEvent,
  type ClientLiveEvent,
  type LiveErrorCode,
  type ServerLiveEvent,
} from "@nova/shared";

import type { SttEngine, SttSessionHandle } from "../stt/ports.js";

import {
  createDisposer,
  noopAudioFrameHandler,
  type AudioFrameHandler,
  type Disposer,
  type LiveLogger,
  type TranscriptPersister,
} from "./ports.js";

/** PCM sample rate of the mic feed handed to the STT vendor (design doc: 16 kHz). */
const STT_SAMPLE_RATE_HZ = 16000;

/**
 * One live session per socket (per-user concurrency caps are Phase 6 — not
 * here). Transport-agnostic on purpose: it takes a `send` callback and is fed
 * decoded text / binary messages, so the whole lifecycle is unit-testable
 * without a real WebSocket. `routes.ts` is the only thing that knows about `ws`.
 */

export interface LiveSessionDeps {
  /** Emit a typed event down the socket (serialization lives in the transport). */
  send: (event: ServerLiveEvent) => void;
  /** Binary-audio seam; defaults to a no-op (Task 4 wires the STT relay). */
  onAudioFrame?: AudioFrameHandler;
  /** Session id factory; overridable for deterministic tests. */
  generateSessionId?: () => string;
  /**
   * Whether the TEST-ONLY `echo` mode may be honored. The transport passes
   * `NODE_ENV !== "production"` so echo can never be triggered in production
   * even if a client sends `echo: true`.
   */
  allowEcho?: boolean;
  /**
   * The STT engine over the configured vendor lineup. On `session.start` a
   * per-call engine session is started; audio frames relay into it and its
   * transcript / `provider_switched` / `error` events go straight down the
   * socket via {@link send}. Omitted in pure protocol unit tests; the transport
   * always supplies one (built from the env vendor registry).
   */
  sttEngine?: SttEngine;
  /**
   * Durable transcript memory. When present (and {@link userId} is set), the
   * session persists every FINAL transcript off the relay path and stamps
   * `ended_at` on disposal. Omitted when the DB is not configured — the session
   * still streams to the phone, just without persistence.
   */
  persister?: TranscriptPersister;
  /** The authenticated caller (the meeting owner). Required to persist. */
  userId?: string;
  /** Structured-error sink for persistence failures (never receives content). */
  logger?: LiveLogger;
}

export class LiveSession {
  /** Run-exactly-once teardown latch; vendor resources register here (Task 4+). */
  readonly disposer: Disposer = createDisposer();

  private readonly send: (event: ServerLiveEvent) => void;
  private readonly onAudioFrame: AudioFrameHandler;
  private readonly generateSessionId: () => string;
  private readonly allowEcho: boolean;
  private readonly sttEngine: SttEngine | null;
  private readonly persister: TranscriptPersister | null;
  private readonly userId: string | null;
  private readonly logger: LiveLogger | null;

  private started = false;
  private sessionId: string | null = null;
  private echo = false;
  /** The meeting this socket is tied to (from `session.start`); null until start. */
  private meetingId: string | null = null;
  /** The live STT relay handle for this call; null until start (or in echo mode). */
  private stt: SttSessionHandle | null = null;
  /**
   * In-flight final-transcript writes. `markEnded` waits on these so a call is
   * never stamped ended while its own transcript rows are still being written.
   */
  private readonly pendingWrites = new Set<Promise<void>>();

  constructor(deps: LiveSessionDeps) {
    this.send = deps.send;
    this.onAudioFrame = deps.onAudioFrame ?? noopAudioFrameHandler;
    this.generateSessionId = deps.generateSessionId ?? randomUUID;
    this.allowEcho = deps.allowEcho ?? false;
    this.sttEngine = deps.sttEngine ?? null;
    this.persister = deps.persister ?? null;
    this.userId = deps.userId ?? null;
    this.logger = deps.logger ?? null;
  }

  /** The generated session id once `session.start` has been accepted. */
  get id(): string | null {
    return this.sessionId;
  }

  /**
   * Handle one inbound TEXT frame (a JSON control event). A malformed frame is
   * answered with an `error` event and DROPPED — a single bad frame never tears
   * down the session (that is what WS close codes are for).
   */
  handleTextMessage(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.sendError("invalid_json", "message was not valid JSON");
      return;
    }

    const parsed = parseClientEvent(json);
    if (!parsed.success) {
      this.sendError("invalid_event", "unrecognized or malformed live event");
      return;
    }
    this.dispatch(parsed.data);
  }

  /**
   * Handle one inbound BINARY frame — the audio path. Before `session.start` it
   * is an error (and dropped); after, it goes to the audio seam, and in echo
   * mode its byte length is reported back for transit tests.
   */
  handleBinaryMessage(frame: Buffer): void {
    if (!this.started) {
      this.sendError("audio_before_start", "audio frame before session.start");
      return;
    }
    this.onAudioFrame(this, frame);
    // Hot relay into the STT engine (synchronous, throwing-free by contract).
    this.stt?.onAudioFrame(frame);
    if (this.echo) {
      this.send({
        v: LIVE_PROTOCOL_VERSION,
        type: "audio.echo",
        bytes: frame.byteLength,
      });
    }
  }

  /** Idempotent teardown — the single entry point the transport calls on end. */
  close(): void {
    this.disposer.dispose();
  }

  private dispatch(event: ClientLiveEvent): void {
    switch (event.type) {
      case "session.start":
        // `onSessionStart` is async (it awaits the ownership guard when a persister
        // is wired). It catches its own DB errors and never rejects; `void` is safe.
        void this.onSessionStart(event.meeting_id, event.echo ?? false);
        return;
      case "session.end":
        this.close();
        return;
      case "ping":
        this.send({ v: LIVE_PROTOCOL_VERSION, type: "pong" });
        return;
      case "audio.frame":
        // The JSON marker is documentation-only; real audio is binary.
        this.sendError("invalid_event", "audio must be sent as binary frames");
        return;
    }
  }

  private async onSessionStart(
    meetingId: string,
    echo: boolean,
  ): Promise<void> {
    if (this.started) {
      // One live session per socket; a second start is a client protocol bug.
      this.sendError("already_started", "session already started");
      return;
    }
    this.started = true;
    this.echo = this.allowEcho && echo;
    this.meetingId = meetingId;

    // Ownership guard (Phase 4 review C1). The persist path is service-role (RLS +
    // the DB parentage `with_check` are BYPASSED), so before this socket may start
    // STT or write a single transcript, confirm the client-supplied meeting_id names
    // a LIVE meeting owned by the caller — otherwise B could stream a call onto A's
    // meeting_id and wedge A's purge. Awaited BEFORE any engine start / persistence.
    //
    // DEV-MODE BOUNDARY: the guard is only enforced when a persister (DB) is wired.
    // A keyless/DB-less dev session already streams to the phone WITHOUT persistence
    // (routes.ts wires no persister then), so there is nothing to protect and no DB
    // to ask; that path stays guard-free, exactly as it streams without persistence.
    if (this.persister !== null && this.userId !== null) {
      let owned: boolean;
      try {
        owned = await this.persister.verifyMeetingOwnership(
          meetingId,
          this.userId,
        );
      } catch (err: unknown) {
        // Fail CLOSED: a DB-unavailable start is REFUSED (typed error + policy
        // close), never silently accepted. Log ids only (never content, RULES §6).
        this.logger?.error(
          { user_id: this.userId, meeting_id: meetingId, err },
          "live.meeting_ownership_check_failed",
        );
        this.sendError("internal", "could not verify meeting ownership");
        this.close();
        return;
      }
      if (!owned) {
        this.sendError(
          "meeting_forbidden",
          "meeting not found or not owned by caller",
        );
        this.close();
        return;
      }
      // The socket may have dropped while the guard was in flight — the disposer
      // ran, so do not resurrect a dead session (no ready, no engine, no writes).
      if (this.disposer.disposed) return;
    }

    this.sessionId = this.generateSessionId();
    this.send({
      v: LIVE_PROTOCOL_VERSION,
      type: "session.ready",
      session_id: this.sessionId,
    });

    // Persistence teardown: on ANY disposal path (client end, socket close, error)
    // flush pending final-transcript writes then stamp `ended_at`. Registered
    // BEFORE the STT stop below so LIFO runs stop() first (no new finals arrive),
    // then this flush + mark. Only when a persister + owner are wired.
    if (this.persister !== null && this.userId !== null) {
      this.disposer.add(() => {
        void this.finalizePersistence();
      });
    }

    // Start the STT relay for this call. Echo mode is the pre-vendor transit
    // diagnostic, so it deliberately bypasses the engine; otherwise a per-call
    // engine session streams transcript/provider_switched/error events straight
    // to the socket, and its teardown rides the exactly-once disposer (a dropped
    // phone must abort the vendor socket — the money-leak rule, design doc).
    if (this.sttEngine !== null && !this.echo) {
      const stt = this.sttEngine.startSession(
        { sessionId: this.sessionId, sampleRateHz: STT_SAMPLE_RATE_HZ },
        this.onServerEvent,
      );
      this.stt = stt;
      this.disposer.add(() => {
        stt.stop();
      });
    }
  }

  /**
   * The engine's emit sink: forward every event to the socket UNCHANGED (the relay
   * stays synchronous), then — for FINAL transcripts only — kick off a durable
   * write. Partials are never persisted (RULES). The write is fire-and-forget so a
   * slow/failed DB never delays or drops a socket send.
   */
  private readonly onServerEvent = (event: ServerLiveEvent): void => {
    this.send(event);
    if (event.type === "transcript.final") {
      this.persistFinal(event.text, event.speaker, event.ts_ms);
    }
  };

  /** Fire-and-forget persist of one final utterance; errors logged, never thrown. */
  private persistFinal(
    content: string,
    speaker: string | null,
    tsMs: number | null,
  ): void {
    const persister = this.persister;
    const meetingId = this.meetingId;
    const userId = this.userId;
    if (persister === null || meetingId === null || userId === null) return;

    const write = persister
      .saveFinal({ meetingId, userId, content, speaker, tsMs })
      .catch((err: unknown) => {
        // A DB hiccup must never surface to the relay — log with ids only (never
        // transcript content, RULES §6) and move on.
        this.logger?.error(
          { user_id: userId, meeting_id: meetingId, err },
          "live.transcript_persist_failed",
        );
      });
    this.pendingWrites.add(write);
    void write.finally(() => {
      this.pendingWrites.delete(write);
    });
  }

  /**
   * Teardown persistence: await every in-flight final write, THEN mark the call
   * ended. Runs at most once (guarded by the exactly-once disposer). Best-effort —
   * a failed `markEnded` is logged; the sweeper only indexes meetings whose
   * `ended_at` is set, so a lost stamp simply means this call is not yet indexed.
   */
  private async finalizePersistence(): Promise<void> {
    const persister = this.persister;
    const meetingId = this.meetingId;
    const userId = this.userId;
    if (persister === null || meetingId === null || userId === null) return;

    // Flush before markEnded: a meeting must never be stamped ended (and swept
    // for indexing) while its own transcript rows are still in flight.
    await Promise.allSettled([...this.pendingWrites]);
    try {
      await persister.markEnded(meetingId, userId);
    } catch (err: unknown) {
      this.logger?.error(
        { user_id: userId, meeting_id: meetingId, err },
        "live.mark_ended_failed",
      );
    }
  }

  private sendError(code: LiveErrorCode, message: string): void {
    this.send({ v: LIVE_PROTOCOL_VERSION, type: "error", code, message });
  }
}
